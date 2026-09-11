import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Chunk, Query, RoutedQuery } from "@app/rag-core";
import { MACHINE_TRANSLATION_LABEL, createKajianQAssembler } from "./chat-assembler";
import { createKajianQRetriever } from "./chat-retriever";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";
import type { KajianQFilters } from "./filters";

/**
 * INTEGRATION TEST (thermo-review C1) — the retriever ↔ assembler contract.
 *
 * The gap this closes: every other test in the suite builds its own fixture
 * shape, so a stage could read metadata the previous stage never wrote and
 * still pass (that is exactly how A1 shipped — the assembler's Arabic +
 * labeled-translation rule read `metadata["textAr"]`/`["textId"]`, which the
 * retriever never populated, so the ADR-0006 rule was dead on the real path
 * while its unit tests passed on hand-built chunks).
 *
 * This test spans the real store → retriever → assembler path with no fixture
 * shortcuts: a child is inserted through `createMemoryRagStore`, retrieved
 * through `createKajianQRetriever` (the same chunk construction production
 * uses), and assembled by `createKajianQAssembler`. It fails if the retriever
 * stops carrying the text layers, or the assembler stops rendering them.
 */

const ARABIC = "اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ";
const TRANSLATION = "Allah, tidak ada tuhan selain Dia, Yang Mahahidup.";
const CITATION = "QS. 2:255";

/** The primary-track (Arabic) vector; the fallback track is the translation. */
const PRIMARY_VEC = [1, 0, 0];
const FALLBACK_VEC = [0, 1, 0];

/** A parent + child chunk as ingestion writes them (columns, not metadata). */
async function seedAyatKursi(store: ReturnType<typeof createMemoryRagStore>): Promise<string> {
  const parentId = await Effect.runPromise(
    store.insertDocParent({ sourceKey: "quran/2", title: "Al-Baqarah", metadata: {} }),
  );
  const childId = await Effect.runPromise(
    store.insertDocChild({
      parentId,
      textRaw: ARABIC,
      textAr: ARABIC,
      textId: TRANSLATION,
      citation: { sourceType: "quran", surah: 2, ayah: 255 },
      embeddingPrimary: PRIMARY_VEC,
      embeddingFallback: FALLBACK_VEC,
      ordinal: 0,
      // The ingestion-written metadata shape: NO textAr/textId keys here —
      // that is the point. The retriever must add the text layers itself.
      metadata: { sourceType: "quran", citation: CITATION },
    }),
  );
  return childId;
}

/** Run the retriever against the memory store, returning its chunks. */
async function retrieve(
  store: ReturnType<typeof createMemoryRagStore>,
  track: "primary" | "fallback" = "primary",
): Promise<readonly Chunk[]> {
  const vector = track === "primary" ? PRIMARY_VEC : FALLBACK_VEC;
  const retriever = createKajianQRetriever({
    store,
    embedder: { embed: () => Effect.succeed({ vectors: [vector], cost: stubCost() }) },
    bridge: (effect) => Effect.runPromise(effect),
  });
  const routed: RoutedQuery<KajianQFilters> = {
    intent: "Apa itu Ayat Kursi?",
    subQueries: [{ text: "Apa itu Ayat Kursi?" }],
    filters: {},
  };
  return Effect.runPromise(retriever.retrieve(routed));
}

function stubCost() {
  return { modelId: "stub-embedder", tokensIn: 1, tokensOut: 1, latencyMs: 1, costMicroUsd: 0 };
}

/** Assemble the retrieved chunks through the real assembler. */
function assemble(chunks: readonly Chunk[]): string {
  const query: Query<KajianQFilters> = { text: "Apa itu Ayat Kursi?" };
  const ctx = Effect.runSync(
    createKajianQAssembler().assemble(query, chunks) as never,
  ) as { turns: readonly { content: string }[] };
  return ctx.turns.map((t) => t.content).join("\n");
}

describe("retriever → assembler (the cross-layer metadata contract)", () => {
  it("carries both text layers from the store into the chunk metadata", async () => {
    const store = createMemoryRagStore();
    const childId = await seedAyatKursi(store);
    const chunks = await retrieve(store);
    const chunk = chunks.find((c) => c.id === childId);
    expect(chunk).toBeTruthy();
    // The retriever, not the fixture, must supply these (A1).
    expect(chunk?.metadata?.["textAr"]).toBe(ARABIC);
    expect(chunk?.metadata?.["textId"]).toBe(TRANSLATION);
  });

  it("renders the Arabic original, the labeled translation, and the citation", async () => {
    const store = createMemoryRagStore();
    await seedAyatKursi(store);
    const context = assemble(await retrieve(store));
    expect(context).toContain(ARABIC);
    expect(context).toContain(MACHINE_TRANSLATION_LABEL);
    expect(context).toContain(TRANSLATION);
    expect(context).toContain(`[${CITATION}]`);
  });

  it("omits the translation label when the store returned no translation layer", async () => {
    const store = createMemoryRagStore();
    const parentId = await Effect.runPromise(
      store.insertDocParent({ sourceKey: "quran/2", title: "Al-Baqarah", metadata: {} }),
    );
    await Effect.runPromise(
      store.insertDocChild({
        parentId,
        textRaw: ARABIC,
        textAr: ARABIC,
        textId: null,
        citation: { sourceType: "quran", surah: 2, ayah: 255 },
        embeddingPrimary: PRIMARY_VEC,
        embeddingFallback: null,
        ordinal: 0,
        metadata: { sourceType: "quran", citation: CITATION },
      }),
    );
    const context = assemble(await retrieve(store));
    expect(context).toContain(ARABIC);
    // No translation in hand → no provenance claim about one (ADR-0006).
    expect(context).not.toContain(MACHINE_TRANSLATION_LABEL);
  });

  it("renders the translation track's text when the primary track has no embedding", async () => {
    // The fallback-only shape: the store has a translation layer but no
    // Arabic embedding, so retrieval returns the chunk from the fallback
    // track. The assembler must still not claim a labeled translation pair
    // unless both layers are present — here they are, so the pair renders.
    const store = createMemoryRagStore();
    const parentId = await Effect.runPromise(
      store.insertDocParent({ sourceKey: "quran/2", title: "Al-Baqarah", metadata: {} }),
    );
    await Effect.runPromise(
      store.insertDocChild({
        parentId,
        textRaw: ARABIC,
        textAr: ARABIC,
        textId: TRANSLATION,
        citation: { sourceType: "quran", surah: 2, ayah: 255 },
        embeddingPrimary: null,
        embeddingFallback: FALLBACK_VEC,
        ordinal: 0,
        metadata: { sourceType: "quran", citation: CITATION },
      }),
    );
    const context = assemble(await retrieve(store, "fallback"));
    expect(context).toContain(ARABIC);
    expect(context).toContain(MACHINE_TRANSLATION_LABEL);
    expect(context).toContain(TRANSLATION);
  });
});
