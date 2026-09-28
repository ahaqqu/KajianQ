import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { RunContext, type Chunk, type RoutedQuery } from "@app/rag-core";
import { createKajianQAssembler } from "./chat-assembler";
import { validateCitations } from "./chat-citation-validator";
import {
  DEFAULT_NEIGHBOUR_CAP,
  DEFAULT_NEIGHBOUR_RADIUS,
  NEIGHBOUR_EXPANSION_ORIGIN,
  SCOPE_EXPANSION_ORIGIN,
  expandVerseNeighbours,
} from "./chat-expansions";
import { createKajianQRetriever } from "./chat-retriever";
import type { KajianQFilters } from "./filters";
import { surahSourceKey } from "./quran-source";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";

/**
 * Retrieved-verse neighbourhood expansion (ADR-0049) — the retrieval half of
 * #274.
 *
 * The invariant under test: a verse **retrieval returned** brings its own
 * ordinal neighbourhood into the context — bounded by a radius and a cap,
 * anchored on the retrieved row (never on a derived position), deduplicated
 * against everything already in context, and readable back off the trace.
 *
 * Adversarial cases named before writing:
 * - a verse at an ARBITRARY ordinal (255 of 286) must receive *its* neighbours,
 *   not the surah's opening window — the read ADR-0045 already had cannot serve
 *   this anchor, so this row is what proves the new one is used;
 * - an anchor-ordering / cap interaction: the budget must be spent on the
 *   best-ranked evidence's neighbourhood, not on an arbitrary subset;
 * - a neighbour that is already a fused hit AND one that is already a
 *   surah-scope chunk must not be added twice, and `returned` must count only
 *   what was actually added;
 * - the cap must truncate and SAY SO (`truncated`), probing `cap + 1`;
 * - `radius <= 0` and `cap <= 0` must disable the expansion *and* the store
 *   read (no silent per-request query), and a context with no verse must not
 *   read at all;
 * - every added chunk must resolve to a read that produced it: same parent,
 *   within `radius` ordinals of an anchor the event names.
 */

const COST = { modelId: "stub-embedder", tokensIn: 1, tokensOut: 1, latencyMs: 1, costMicroUsd: 0 };
const QUERY_VEC = [1, 0];
/** Identical to the query vector: this verse is a fused hit. */
const NEAR_VEC = [1, 0];
/** Orthogonal to the query: present in the corpus, never a fused hit. */
const FAR_VEC = [0, 1];

type Store = ReturnType<typeof createMemoryRagStore>;

/** Seed a surah whose `nearAyahs` are the fused-retrievable ones. */
async function seedSurah(
  store: Store,
  surah: number,
  ayahCount: number,
  nearAyahs: readonly number[] = [],
): Promise<void> {
  const parentId = await Effect.runPromise(
    store.insertDocParent({
      sourceKey: surahSourceKey(surah),
      title: `QS. ${surah}`,
      metadata: { sourceType: "quran", surah },
    }),
  );
  await Effect.runPromise(
    store.insertDocChildren(
      Array.from({ length: ayahCount }, (_, i) => {
        const ayah = i + 1;
        return {
          parentId,
          textRaw: `ar-${surah}:${ayah}`,
          textAr: `ar-${surah}:${ayah}`,
          textId: `id-${surah}:${ayah}`,
          citation: { sourceType: "quran", surah, ayah },
          embeddingPrimary: nearAyahs.includes(ayah) ? NEAR_VEC : FAR_VEC,
          embeddingFallback: null,
          ordinal: i,
          metadata: { sourceType: "quran", surah, ayah, citation: `QS. ${surah}:${ayah}` },
        };
      }),
    ),
  );
}

/** Al-Baqarah (286) with 2:255 retrievable — the Ayat-Kursi shape of #274. */
async function baqarah(): Promise<Store> {
  const store = createMemoryRagStore();
  await seedSurah(store, 2, 286, [255]);
  return store;
}

/** The real stored row for one verse: real id, real ordinal, real metadata. */
async function rowOf(store: Store, surah: number, ayah: number) {
  const rows = await Effect.runPromise(
    store.listDocChildrenByParentSourceKey(surahSourceKey(surah), { limit: 286 }),
  );
  const row = rows.find((r) => r.metadata["ayah"] === ayah);
  if (row === undefined) throw new Error(`no stored row for QS. ${surah}:${ayah}`);
  return row;
}

/** The stored row as the retriever would hand it on: a `Chunk`. */
function chunkOf(
  row: { id: string; textAr: string; metadata: Record<string, unknown> },
  origin?: string,
): Chunk {
  return {
    id: row.id,
    text: row.textAr,
    ...(origin !== undefined ? { origin } : {}),
    metadata: row.metadata,
  };
}

function routed(sourceText: string, subQueries: string[]): RoutedQuery<KajianQFilters> {
  return {
    intent: "factual",
    subQueries: subQueries.map((text) => ({ text })),
    filters: {},
    sourceText,
  };
}

/** The retriever harness: the real store, a spy on the anchored read. */
function harness(
  store: Store,
  opts: { radius?: number; cap?: number; limit?: number } = {},
): {
  retrieve: (input: RoutedQuery<KajianQFilters>) => Promise<readonly Chunk[]>;
  events: { kind: string; detail?: unknown }[];
  reads: { count: number; lastRadius: number; lastLimit: number; lastAnchors: readonly string[] };
} {
  const events: { kind: string; detail?: unknown }[] = [];
  const reads = { count: 0, lastRadius: -1, lastLimit: -1, lastAnchors: [] as readonly string[] };
  const spy = {
    ...store,
    listDocChildNeighboursByChildIds(
      anchors: readonly string[],
      readOpts: { radius: number; limit: number },
    ) {
      reads.count += 1;
      reads.lastRadius = readOpts.radius;
      reads.lastLimit = readOpts.limit;
      reads.lastAnchors = anchors;
      return store.listDocChildNeighboursByChildIds(anchors, readOpts);
    },
  };
  const retriever = createKajianQRetriever({
    store: spy,
    embedder: { embed: () => Effect.succeed({ vectors: [QUERY_VEC], cost: COST }) },
    bridge: (effect) => Effect.runPromise(effect),
    limit: opts.limit ?? 1,
    ...(opts.radius !== undefined ? { neighbourRadius: opts.radius } : {}),
    ...(opts.cap !== undefined ? { neighbourCap: opts.cap } : {}),
  });
  const retrieve = (input: RoutedQuery<KajianQFilters>) =>
    Effect.runPromise(
      Effect.provideService(retriever.retrieve(input) as never, RunContext, {
        config: {},
        now: () => 1,
        record: (event: unknown) => events.push(event as { kind: string }),
      } as never) as never,
    ) as Promise<readonly Chunk[]>;
  return { retrieve, events, reads };
}

function labelsOf(chunks: readonly Chunk[]): string[] {
  return chunks
    .map((c) => (c.metadata ?? {})["citation"])
    .filter((c): c is string => typeof c === "string");
}

function neighbourLabels(chunks: readonly Chunk[]): string[] {
  return labelsOf(chunks.filter((c) => c.origin === NEIGHBOUR_EXPANSION_ORIGIN));
}

/** A unit-level call, with context chunks the caller assembles (the seam). */
function expand(
  store: Store,
  retrieved: readonly Chunk[],
  opts: { radius?: number; cap?: number } = {},
) {
  return Effect.runPromise(
    expandVerseNeighbours({
      retrieved,
      radius: opts.radius ?? DEFAULT_NEIGHBOUR_RADIUS,
      cap: opts.cap ?? DEFAULT_NEIGHBOUR_CAP,
      store,
      bridge: (effect) => Effect.runPromise(effect),
    }),
  );
}

describe("retrieved-verse neighbourhood expansion", () => {
  it("anchors on a retrieved verse at an ARBITRARY ordinal, not the surah's opening", async () => {
    const store = await baqarah();
    const { retrieve, events, reads } = harness(store);
    const chunks = await retrieve(
      routed("Apa yang dimaksud dengan ayat yang agung?", ["ayat agung"]),
    );

    // The fused hit is 2:255 (ordinal 254 of 286); no scope expansion runs,
    // because the question names no surah.
    expect(labelsOf(chunks.filter((c) => c.origin === undefined))).toEqual(["QS. 2:255"]);
    // Its OWN neighbours arrive: 2:254 and 2:256. A parent-scoped opening read
    // would have produced 2:1..2:3 instead — this is the row that pins the
    // anchor.
    expect(neighbourLabels(chunks).sort()).toEqual(["QS. 2:254", "QS. 2:256"]);
    expect(neighbourLabels(chunks)).not.toContain("QS. 2:1");
    expect(reads.lastRadius).toBe(DEFAULT_NEIGHBOUR_RADIUS);
    const event = events.find((e) => e.kind === "neighbour_expansion") as
      | {
          detail: {
            anchors: string[];
            returned: number;
            radius: number;
            cap: number;
            truncated: boolean;
          };
        }
      | undefined;
    // The event names the one anchor the read was keyed on, so the two added
    // chunks resolve to it (same parent, one ordinal away).
    expect([...reads.lastAnchors]).toEqual(event?.detail.anchors);
    expect(event?.detail).toEqual({
      anchors: [...reads.lastAnchors],
      returned: 2,
      radius: DEFAULT_NEIGHBOUR_RADIUS,
      cap: DEFAULT_NEIGHBOUR_CAP,
      truncated: false,
    });
  });

  it("spends the cap on the best-ranked evidence's neighbourhood, in retrieval order", async () => {
    const store = createMemoryRagStore();
    await seedSurah(store, 2, 10, [3]);
    await seedSurah(store, 3, 10, [5]);
    const best = chunkOf(await rowOf(store, 2, 3));
    const worse = chunkOf(await rowOf(store, 3, 5));
    // The caller's order IS the priority order: the read is keyed on it, and
    // the cap truncates the tail windows first.
    const result = await expand(store, [best, worse], { cap: 2 });
    expect(result.detail?.anchors).toEqual([best.id, worse.id]);
    // 2:3's window (2:2, 2:4) fills the budget; 3:5's does not get in.
    expect(labelsOf(result.chunks).sort()).toEqual(["QS. 2:2", "QS. 2:4"]);
    expect(result.detail?.truncated).toBe(true);
  });

  it("reads one past the cap and reports the truncation exactly", async () => {
    const store = createMemoryRagStore();
    await seedSurah(store, 2, 10, [4, 5]);
    const { retrieve, events, reads } = harness(store, { radius: 1, cap: 2, limit: 2 });
    const chunks = await retrieve(routed("Pertanyaan tanpa nama surah", ["generic question"]));
    // Anchors 2:4 and 2:5; their union window minus the anchors is {3, 6} —
    // exactly the cap, so nothing was truncated and the probe saw no more.
    expect(reads.lastLimit).toBe(3);
    expect(neighbourLabels(chunks).sort()).toEqual(["QS. 2:3", "QS. 2:6"]);
    const event = events.find((e) => e.kind === "neighbour_expansion") as
      | { detail: { returned: number; truncated: boolean; anchors: string[] } }
      | undefined;
    expect(event?.detail.returned).toBe(2);
    expect(event?.detail.truncated).toBe(false);
    expect(event?.detail.anchors).toHaveLength(2);
  });

  it("does not add a neighbour that is already a fused hit or a scope chunk", async () => {
    const store = await baqarah();
    // 2:255 arrives as a fused hit and 2:256 as ADR-0045's scope chunk; both
    // are already in context, so 2:256 may not be added twice and `returned`
    // counts only the addition (2:254).
    const already: Chunk[] = [
      chunkOf(await rowOf(store, 2, 255)),
      chunkOf(await rowOf(store, 2, 256), SCOPE_EXPANSION_ORIGIN),
    ];
    const result = await expand(store, already, { radius: 1, cap: 12 });
    // 2:256 is a neighbour of 2:255 but already in context (as the scope chunk)
    // and is skipped; its own far neighbour 2:257 is a genuine addition.
    expect(labelsOf(result.chunks).sort()).toEqual(["QS. 2:254", "QS. 2:257"]);
    expect(result.chunks.every((c) => c.origin === NEIGHBOUR_EXPANSION_ORIGIN)).toBe(true);
    expect(result.detail?.returned).toBe(2);
    // Exactly one copy of each label in the union the retriever returns.
    const union = [...already, ...result.chunks];
    for (const label of ["QS. 2:254", "QS. 2:255", "QS. 2:256", "QS. 2:257"]) {
      expect(union.filter((c) => labelsOf([c])[0] === label)).toHaveLength(1);
    }
  });

  it("disables the expansion — and the store read — at radius 0 or cap 0", async () => {
    for (const off of [{ radius: 0 }, { cap: 0 }]) {
      const store = await baqarah();
      const { retrieve, events, reads } = harness(store, off);
      const chunks = await retrieve(routed("Pertanyaan tanpa nama surah", ["generic question"]));
      expect(chunks.some((c) => c.origin === NEIGHBOUR_EXPANSION_ORIGIN)).toBe(false);
      expect(events.filter((e) => e.kind === "neighbour_expansion")).toHaveLength(0);
      // Disabled means no round trip at all, not a read whose result is dropped.
      expect(reads.count).toBe(0);
      // The fused path is untouched: the context still holds what it retrieved.
      expect(labelsOf(chunks)).toContain("QS. 2:255");
    }
  });

  it("does not read the store when the context holds no verse", async () => {
    const store = createMemoryRagStore();
    const parentId = await Effect.runPromise(
      store.insertDocParent({
        sourceKey: "hadith/malik/1",
        title: "HR. Malik no. 1",
        metadata: { sourceType: "hadith" },
      }),
    );
    const hadithId = await Effect.runPromise(
      store.insertDocChild({
        parentId,
        textRaw: "hadith-ar",
        textAr: "hadith-ar",
        textId: "hadith-id",
        citation: { sourceType: "hadith", collection: "Malik", number: 1 },
        embeddingPrimary: NEAR_VEC,
        embeddingFallback: NEAR_VEC,
        ordinal: 0,
        metadata: { sourceType: "hadith", citation: "HR. Malik no. 1", grade: "sahih" },
      }),
    );
    const { retrieve, events, reads } = harness(store);
    const chunks = await retrieve(routed("Pertanyaan tanpa nama surah", ["generic question"]));
    // The hadith is retrieved and nothing else — no verse to anchor on, so the
    // expansion costs no round trip and records nothing.
    expect(chunks.map((c) => c.id)).toContain(hadithId);
    expect(events.filter((e) => e.kind === "neighbour_expansion")).toHaveLength(0);
    expect(reads.count).toBe(0);
    const result = await expand(store, chunks);
    expect(result.chunks).toEqual([]);
    expect(result.detail).toBeNull();
  });

  it("resolves every added chunk to a read the event names (same parent, within radius)", async () => {
    const store = await baqarah();
    const { retrieve, events } = harness(store, { radius: 2, cap: 12 });
    const chunks = await retrieve(routed("Pertanyaan tanpa nama surah", ["generic question"]));
    const event = events.find((e) => e.kind === "neighbour_expansion") as
      | { detail: { anchors: string[]; radius: number; returned: number } }
      | undefined;
    expect(event).toBeDefined();
    const rows = await Effect.runPromise(
      store.listDocChildrenByParentSourceKey(surahSourceKey(2), { limit: 286 }),
    );
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const anchorRows = (event?.detail.anchors ?? []).map((id) => rowById.get(id));
    expect(anchorRows.every((row) => row !== undefined)).toBe(true);
    const added = chunks.filter((c) => c.origin === NEIGHBOUR_EXPANSION_ORIGIN);
    expect(added).toHaveLength(event?.detail.returned ?? -1);
    expect(added.length).toBeGreaterThan(0);
    for (const chunk of added) {
      const row = rowById.get(chunk.id);
      expect(row, chunk.id).toBeDefined();
      const resolved = anchorRows.some(
        (anchor) =>
          anchor?.parentId === row?.parentId &&
          Math.abs((anchor?.ordinal ?? NaN) - (row?.ordinal ?? NaN)) <= (event?.detail.radius ?? 0),
      );
      expect(resolved, `${chunk.id} must resolve to a named anchor`).toBe(true);
    }
  });

  it("carries both text layers on the chunks it adds (ADR-0006 stays live)", async () => {
    const store = await baqarah();
    const { retrieve } = harness(store);
    const chunks = await retrieve(routed("Pertanyaan tanpa nama surah", ["generic question"]));
    const added = chunks.filter((c) => c.origin === NEIGHBOUR_EXPANSION_ORIGIN);
    expect(added.length).toBeGreaterThan(0);
    for (const chunk of added) {
      expect(chunk.metadata?.["textAr"]).toBeTruthy();
      expect(chunk.metadata?.["textId"]).toBeTruthy();
    }
  });
});

/**
 * The acceptance boundary #274 asks for: the **assembled context** the gate
 * actually reads. The retrieved set is the failing trace's own shape (`QS. 3:2`
 * as the fused hit), the draft is the real failing label (`QS. 3:1-2`), and
 * the assertion is on `AssembledContext.chunks` — not on a hand-built list.
 */
describe("the assembled context grounds the real failing label (#274)", () => {
  async function alImran(opts: { radius?: number } = {}): Promise<{
    chunks: readonly Chunk[];
    context: string;
  }> {
    const store = createMemoryRagStore();
    // The failing trace's own Al-Imran labels were 3:2, 3:18 and 3:189, with
    // 3:2 the top-ranked primary hit; the corpus here carries surah 3 so the
    // neighbourhood of 3:2 is reachable.
    await seedSurah(store, 3, 200, [2]);
    const { retrieve } = harness(store, { limit: 1, ...opts });
    const chunks = await retrieve(
      routed("Apa maksud Ayat Kursi?", ["makna ayat kursi", "tafsir ayat kursi"]),
    );
    const assembled = await Effect.runPromise(
      createKajianQAssembler().assemble({ text: "Apa maksud Ayat Kursi?", filters: {} }, chunks),
    );
    return {
      chunks: assembled.chunks,
      context: assembled.turns.map((turn) => turn.content).join("\n"),
    };
  }

  it("puts QS. 3:1 in the assembled context, so the range grounds", async () => {
    const { chunks, context } = await alImran();
    // The retrieved verse and its head are BOTH in what the gate reads.
    expect(labelsOf(chunks)).toContain("QS. 3:2");
    expect(labelsOf(chunks)).toContain("QS. 3:1");
    // …and the prompt renders both labels, so the model can cite them.
    expect(context).toContain("[QS. 3:1]");
    expect(context).toContain("[QS. 3:2]");
    // The gate's own call, on the real failing label, at this boundary.
    expect(validateCitations("Dalilnya QS. 3:1-2 tentang hal ini", chunks).ungrounded).toEqual([]);
  });

  it("still refuses a range with no retrieved member, and a single fabricated verse", async () => {
    const { chunks } = await alImran();
    // No member of this range is in the context (surah 9 is not in the corpus).
    expect(validateCitations("Dalilnya QS. 9:99-100", chunks).ungrounded).toEqual(["QS. 9:99-100"]);
    // A single fabricated verse, unchanged from #264's matrix.
    expect(validateCitations("Dalilnya QS. 9:99", chunks).ungrounded).toEqual(["QS. 9:99"]);
    // A range reaching past the neighbourhood window: 3:4 and 3:5 were never
    // retrieved, so the range asserts grounding it does not have.
    expect(validateCitations("Dalilnya QS. 3:1-5", chunks).ungrounded).toEqual(["QS. 3:1-5"]);
  });

  it("is falsifiable: the same pipeline with the expansion disabled reddens the row", async () => {
    // The named mutation for the acceptance row: NEIGHBOUR_EXPANSION_RADIUS=0
    // (the documented disable). Everything else is identical, so the row that
    // moves is the expansion's own.
    const { chunks } = await alImran({ radius: 0 });
    expect(labelsOf(chunks)).not.toContain("QS. 3:1");
    expect(validateCitations("Dalilnya QS. 3:1-2 tentang hal ini", chunks).ungrounded).toEqual([
      "QS. 3:1-2",
    ]);
    // The negative rows do not move: they are red with or without the change.
    expect(validateCitations("Dalilnya QS. 9:99", chunks).ungrounded).toEqual(["QS. 9:99"]);
    expect(validateCitations("Dalilnya QS. 9:99-100", chunks).ungrounded).toEqual(["QS. 9:99-100"]);
  });
});
