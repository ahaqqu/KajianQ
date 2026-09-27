import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { RunContext, type Chunk, type RoutedQuery } from "@app/rag-core";
import { createKajianQRetriever } from "./chat-retriever";
import { runChatPipeline } from "./chat-pipeline";
import { DEFAULT_SCOPE_EXPANSION_CAP, SCOPE_EXPANSION_ORIGIN } from "./chat-scope-expansion";
import type { KajianQFilters } from "./filters";
import { surahSourceKey } from "./quran-source";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";
import { createStubChatProviders } from "./test-utils/stub-chat-providers";

/**
 * Surah-reference scoped expansion (ADR-0045) — the retrieval behaviour.
 *
 * The invariant under test: a question that names a surah retrieves that
 * surah's children **deterministically and bounded**, alongside (never
 * instead of) the fused hits; a question that names no surah retrieves
 * nothing extra; and the result does not depend on the router's paraphrase.
 *
 * Adversarial cases named before writing:
 * - the exact #241 sub-query pair (failing vs passing wording) must produce
 *   the same expansion, including `QS. 1:1`, which both previously missed;
 * - a paraphrase that drops the surah name entirely must still expand (the
 *   scope is detected on the verbatim question, not the sub-queries);
 * - a long surah (Al-Baqarah, 286 verses) must be capped, and the cap must be
 *   reported as truncation;
 * - a child already produced by the fused tracks must not be duplicated or
 *   counted as expansion output;
 * - a question naming no surah must not read the store at all (no silent
 *   extra query per request).
 */

const COST = { modelId: "stub-embedder", tokensIn: 1, tokensOut: 1, latencyMs: 1, costMicroUsd: 0 };

/** The query vector: close to the hadith track, far from the Quran track. */
const QUERY_VEC = [1, 0];
const HADITH_VEC = [1, 0];
const QURAN_VEC = [0, 1];

const GS_V0_015 = "What does Surah Al-Fatihah mean and why is it recited in every prayer?";
/** The failing sub-query from #241's trace (`eval_run 127a6bc5…`). */
const FAILING_SUB_QUERIES = [
  "tafsir of Surah Al-Fatihah meaning and virtues",
  "تفسير سورة الفاتحة معانيها وفضلها",
];
/** The passing sub-query from #241's trace (`trace e1321d3e…`). */
const PASSING_SUB_QUERIES = [
  "meaning and tafsir of Surah Al-Fatihah",
  "تفسير سورة الفاتحة ومعانيها",
];

async function seedSurah(
  store: ReturnType<typeof createMemoryRagStore>,
  surah: number,
  ayahCount: number,
): Promise<string> {
  const parentId = await Effect.runPromise(
    store.insertDocParent({
      sourceKey: surahSourceKey(surah),
      title: `QS. ${surah}`,
      metadata: { sourceType: "quran", surah },
    }),
  );
  await Effect.runPromise(
    store.insertDocChildren(
      Array.from({ length: ayahCount }, (_, i) => ({
        parentId,
        textRaw: `ar-${surah}:${i + 1}`,
        textAr: `ar-${surah}:${i + 1}`,
        textId: `id-${surah}:${i + 1}`,
        citation: { sourceType: "quran", surah, ayah: i + 1 },
        // Far from the query vector and unembedded on the fallback track, so
        // the fused retrieval returns none of them — the #142/#241 shape.
        embeddingPrimary: QURAN_VEC,
        embeddingFallback: null,
        ordinal: i,
        metadata: {
          sourceType: "quran",
          surah,
          ayah: i + 1,
          citation: `QS. ${surah}:${i + 1}`,
        },
      })),
    ),
  );
  return parentId;
}

async function seedHadith(store: ReturnType<typeof createMemoryRagStore>): Promise<string> {
  const parentId = await Effect.runPromise(
    store.insertDocParent({
      sourceKey: "hadith/malik/1",
      title: "HR. Malik no. 1",
      metadata: { sourceType: "hadith" },
    }),
  );
  return Effect.runPromise(
    store.insertDocChild({
      parentId,
      textRaw: "hadith-ar",
      textAr: "hadith-ar",
      textId: "hadith-id",
      citation: { sourceType: "hadith", collection: "Malik", number: 1 },
      embeddingPrimary: HADITH_VEC,
      embeddingFallback: HADITH_VEC,
      ordinal: 0,
      metadata: { sourceType: "hadith", citation: "HR. Malik no. 1", grade: "sahih" },
    }),
  );
}

/** A seeded corpus: Al-Fatihah (7), Al-Baqarah (286), and one retrievable hadith. */
async function corpus() {
  const store = createMemoryRagStore();
  await seedSurah(store, 1, 7);
  await seedSurah(store, 2, 286);
  const hadithId = await seedHadith(store);
  return { store, hadithId };
}

type Recorded = { kind: string; detail?: unknown };

function harness(
  store: ReturnType<typeof createMemoryRagStore>,
  cap?: number,
): {
  retrieve: (routed: RoutedQuery<KajianQFilters>) => Promise<readonly Chunk[]>;
  events: Recorded[];
  reads: { count: number; lastLimit: number };
} {
  const events: Recorded[] = [];
  const reads = { count: 0, lastLimit: 0 };
  const spy = {
    ...store,
    listDocChildrenByParentSourceKey(parentSourceKey: string, opts: { limit: number }) {
      reads.count += 1;
      reads.lastLimit = opts.limit;
      return store.listDocChildrenByParentSourceKey(parentSourceKey, opts);
    },
  };
  const retriever = createKajianQRetriever({
    store: spy,
    embedder: { embed: () => Effect.succeed({ vectors: [QUERY_VEC], cost: COST }) },
    bridge: (effect) => Effect.runPromise(effect),
    limit: 1,
    ...(cap !== undefined ? { scopeExpansionCap: cap } : {}),
  });
  const retrieve = (routed: RoutedQuery<KajianQFilters>) =>
    Effect.runPromise(
      Effect.provideService(retriever.retrieve(routed) as never, RunContext, {
        config: {},
        now: () => 1,
        record: (event: unknown) => events.push(event as Recorded),
      } as never) as never,
    ) as Promise<readonly Chunk[]>;
  return { retrieve, events, reads };
}

function routed(sourceText: string, subQueries: string[]): RoutedQuery<KajianQFilters> {
  return {
    intent: "factual",
    subQueries: subQueries.map((text) => ({ text })),
    filters: {},
    sourceText,
  };
}

function labels(chunks: readonly Chunk[]): string[] {
  return chunks
    .map((c) => (c.metadata ?? {})["citation"])
    .filter((c): c is string => typeof c === "string")
    .sort();
}

describe("surah-reference scoped expansion", () => {
  it("adds the named surah's children alongside the fused hits", async () => {
    const { store, hadithId } = await corpus();
    const { retrieve } = harness(store);
    const chunks = await retrieve(routed(GS_V0_015, FAILING_SUB_QUERIES));

    // The fused track still contributes its hadith — expansion never replaces.
    expect(chunks.some((c) => c.id === hadithId)).toBe(true);
    // …and all seven Al-Fatihah verses arrive from the expansion.
    const expansion = chunks.filter((c) => c.origin === SCOPE_EXPANSION_ORIGIN);
    expect(labels(expansion)).toEqual([
      "QS. 1:1",
      "QS. 1:2",
      "QS. 1:3",
      "QS. 1:4",
      "QS. 1:5",
      "QS. 1:6",
      "QS. 1:7",
    ]);
    expect(expansion).toHaveLength(7);
    // The expansion carries both text layers, so the assembler's Arabic +
    // labeled-translation rule stays live on exactly these new chunks.
    for (const chunk of expansion) {
      expect(chunk.metadata?.["textAr"]).toBeTruthy();
      expect(chunk.metadata?.["textId"]).toBeTruthy();
    }
  });

  it("does not expand a question that names no surah (and does not read the store)", async () => {
    const { store } = await corpus();
    const { retrieve, events, reads } = harness(store);
    const chunks = await retrieve(
      routed("What is the ruling on praying in a garment that contains gold?", [
        "ruling on praying in gold garment",
      ]),
    );
    expect(chunks.every((c) => c.origin !== SCOPE_EXPANSION_ORIGIN)).toBe(true);
    expect(events.filter((e) => e.kind === "scope_expansion")).toHaveLength(0);
    expect(reads.count).toBe(0);
  });

  it("caps a long surah and reports the truncation", async () => {
    const { store } = await corpus();
    const cap = 12;
    const { retrieve, events, reads } = harness(store, cap);
    const chunks = await retrieve(routed("Jelaskan isi Surah Al-Baqarah!", ["isi al-baqarah"]));

    const expansion = chunks.filter((c) => c.origin === SCOPE_EXPANSION_ORIGIN);
    expect(expansion).toHaveLength(cap);
    // Deterministic window: the surah's opening, in the corpus's ordinal order
    // (asserted on retrieval order, not on a lexicographic label sort).
    expect(expansion.map((c) => (c.metadata ?? {})["citation"])).toEqual(
      Array.from({ length: cap }, (_, i) => `QS. 2:${i + 1}`),
    );
    // The read probes one past the cap — that is the exact truncation signal.
    expect(reads.lastLimit).toBe(cap + 1);
    const event = events.find((e) => e.kind === "scope_expansion") as
      | {
          detail: { returned: number; cap: number; truncated: boolean; key: string; value: string };
        }
      | undefined;
    expect(event?.detail).toEqual({
      key: "surah",
      value: "2",
      returned: cap,
      cap,
      truncated: true,
    });
  });

  it("uses the configurable default cap when none is passed", async () => {
    const { store } = await corpus();
    const { retrieve } = harness(store);
    const chunks = await retrieve(routed("Jelaskan isi Surah Al-Baqarah!", ["isi al-baqarah"]));
    expect(chunks.filter((c) => c.origin === SCOPE_EXPANSION_ORIGIN)).toHaveLength(
      DEFAULT_SCOPE_EXPANSION_CAP,
    );
  });

  it("expands a verse reference as its surah and records the verse", async () => {
    const { store } = await corpus();
    const { retrieve, events } = harness(store);
    const chunks = await retrieve(routed("Apa makna QS. 2:255?", ["makna ayat kursi"]));
    expect(chunks.filter((c) => c.origin === SCOPE_EXPANSION_ORIGIN).length).toBeGreaterThan(0);
    const event = events.find((e) => e.kind === "scope_expansion") as
      | { detail: { value: string } }
      | undefined;
    expect(event?.detail.value).toBe("2:255");
  });

  it("disables the expansion entirely at cap 0", async () => {
    const { store } = await corpus();
    const { retrieve, events, reads } = harness(store, 0);
    const chunks = await retrieve(routed(GS_V0_015, FAILING_SUB_QUERIES));
    expect(chunks.every((c) => c.origin !== SCOPE_EXPANSION_ORIGIN)).toBe(true);
    expect(events.filter((e) => e.kind === "scope_expansion")).toHaveLength(0);
    expect(reads.count).toBe(0);
  });

  it("records a recognised but empty scope (machinery is never hidden)", async () => {
    const { store } = await corpus();
    const { retrieve, events } = harness(store);
    // Surah 58 is not in the test corpus: the reference is recognised, the
    // read returns nothing, and the trace still says so.
    const chunks = await retrieve(routed("Jelaskan Surah Al-Mujadilah!", ["isi al-mujadilah"]));
    expect(chunks.filter((c) => c.origin === SCOPE_EXPANSION_ORIGIN)).toHaveLength(0);
    const event = events.find((e) => e.kind === "scope_expansion") as
      | { detail: { returned: number; truncated: boolean } }
      | undefined;
    expect(event?.detail.returned).toBe(0);
    expect(event?.detail.truncated).toBe(false);
  });

  it("does not duplicate a child the fused tracks already retrieved", async () => {
    const store = createMemoryRagStore();
    await seedSurah(store, 1, 7);
    // Seed a retrievable hadith so the fused set is non-empty.
    await seedHadith(store);
    // Make one Al-Fatihah verse retrievable too: identical to the query vector.
    const parentId = await Effect.runPromise(
      store.insertDocParent({
        sourceKey: surahSourceKey(1),
        title: "QS. 1",
        metadata: { sourceType: "quran", surah: 1 },
      }),
    );
    await Effect.runPromise(
      store.insertDocChild({
        parentId,
        textRaw: "ar-1:1",
        textAr: "ar-1:1",
        textId: "id-1:1",
        citation: { sourceType: "quran", surah: 1, ayah: 1 },
        embeddingPrimary: HADITH_VEC,
        embeddingFallback: HADITH_VEC,
        ordinal: 0,
        metadata: { sourceType: "quran", surah: 1, ayah: 1, citation: "QS. 1:1" },
      }),
    );
    const { retrieve, events } = harness(store);
    const chunks = await retrieve(routed(GS_V0_015, ["meaning and tafsir of Surah Al-Fatihah"]));
    const qs11 = chunks.filter((c) => (c.metadata ?? {})["citation"] === "QS. 1:1");
    // Exactly once: the fused copy, not a duplicated expansion copy.
    expect(qs11).toHaveLength(1);
    expect(qs11[0]?.origin).toBeUndefined();
    // The expansion therefore added the surah's other six children (7 − 1).
    const event = events.find((e) => e.kind === "scope_expansion") as
      | { detail: { returned: number } }
      | undefined;
    expect(event?.detail.returned).toBe(6);
    expect(chunks.filter((c) => c.origin === SCOPE_EXPANSION_ORIGIN)).toHaveLength(6);
  });
});

/**
 * The evidence for #241 specifically. The flake was caused by sub-query
 * wording, not by the question, so the expansion must be word-for-word
 * identical across the trace's failing and passing sub-query sets — and it
 * must survive a paraphrase that does not name the surah at all, because the
 * scope is read off the verbatim question.
 */
describe("evidence for #241 — expansion is independent of router paraphrase", () => {
  it("retrieves QS. 1:1 under both the failing and the passing sub-queries", async () => {
    const { store } = await corpus();
    const { retrieve } = harness(store);
    const failing = await retrieve(routed(GS_V0_015, FAILING_SUB_QUERIES));
    const passing = await retrieve(routed(GS_V0_015, PASSING_SUB_QUERIES));
    const failingLabels = labels(failing.filter((c) => c.origin === SCOPE_EXPANSION_ORIGIN));
    const passingLabels = labels(passing.filter((c) => c.origin === SCOPE_EXPANSION_ORIGIN));
    // QS. 1:1 (the Basmalah, #142's unreachable short verse) is present in both.
    expect(failingLabels).toContain("QS. 1:1");
    expect(passingLabels).toEqual(failingLabels);
  });

  it("still expands when the sub-queries are paraphrased to drop the surah name", async () => {
    const { store } = await corpus();
    const { retrieve } = harness(store);
    const chunks = await retrieve(
      routed(GS_V0_015, ["virtues and meaning of the opening chapter", "فضل سورة الفاتحة"]),
    );
    expect(labels(chunks.filter((c) => c.origin === SCOPE_EXPANSION_ORIGIN))).toContain("QS. 1:1");
  });
});

/**
 * The whole point of the trace rule: an expansion that left no record would be
 * a silent retrieval path. This runs the real `runChatPipeline` runner — which
 * parses the collected events into the shared `Trace` contract, so a malformed
 * event fails the run — and reads the trace a scorer/operator would read.
 */
describe("the expansion on the persisted answer trace", () => {
  it("records a scope_expansion event and marks the chunks it added", async () => {
    const { store } = await corpus();
    const answer = await Effect.runPromise(
      runChatPipeline(
        {
          ...createStubChatProviders({ answerText: "Jawaban berdasar konteks." }),
          store: store as never,
          bridge: (e) => Effect.runPromise(e as never),
          language: "en",
          // Mirror the retriever tests: a fused set that misses Al-Fatihah
          // entirely, so the expansion is visibly the thing that adds it.
          retrieverLimit: 1,
        },
        { text: GS_V0_015 },
      ) as never,
    );
    const trace = (answer as { trace: { events: Recorded[] } }).trace;
    const scope = trace.events.find((e) => e.kind === "scope_expansion") as
      | {
          detail: { key: string; value: string; returned: number; cap: number; truncated: boolean };
        }
      | undefined;
    expect(scope?.detail).toEqual({
      key: "surah",
      value: "1",
      returned: 7,
      cap: DEFAULT_SCOPE_EXPANSION_CAP,
      truncated: false,
    });
    const retrieval = trace.events.find((e) => e.kind === "retrieval") as
      | { detail: { chunks: { id: string; origin?: string }[] } }
      | undefined;
    const expansionRefs = (retrieval?.detail.chunks ?? []).filter(
      (c) => c.origin === SCOPE_EXPANSION_ORIGIN,
    );
    expect(expansionRefs).toHaveLength(7);
    expect(expansionRefs.every((c) => c.id !== "")).toBe(true);
  });
});
