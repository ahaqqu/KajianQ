// @requires-postgres
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { RunContext, type Chunk, type RoutedQuery } from "@app/rag-core";
import {
  createPostgresRagStore,
  disposePostgresPools,
  postgresPool,
  postgresSqlRunner,
} from "@app/infra";
import { createKajianQAssembler } from "./chat-assembler";
import { validateCitations } from "./chat-citation-validator";
import {
  DEFAULT_NEIGHBOUR_CAP,
  DEFAULT_NEIGHBOUR_RADIUS,
  NEIGHBOUR_EXPANSION_ORIGIN,
  SCOPE_EXPANSION_ORIGIN,
  expandVerseNeighbours,
} from "./chat-retriever-parts";
import { createKajianQRetriever } from "./chat-retriever";
import type { KajianQFilters } from "./filters";
import { surahSourceKey } from "./quran-source";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";
import { routedQuery } from "./test-utils/routed-query";

/**
 * Retrieved-verse neighbourhood expansion (ADR-0049) — the retrieval half.
 *
 * The invariant under test: a verse **retrieval returned** brings its own ordinal
 * neighbourhood into the context — bounded by a radius and a cap, anchored on the
 * retrieved row (never on a derived position), deduplicated against everything
 * already in context, and readable back off the trace.
 *
 * Truncation probes `cap + 1` past the rows the dedup can drop and says so; a disabled
 * expansion (radius <= 0 or cap <= 0) does not read the store at all.
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

/**
 * A parent whose children are NOT all verses: `MIXED_NON_VERSE` commentary rows lead at
 * ordinals 0–7, then `MIXED_VERSES` verses at 8–47. The verse anchor at ordinal 12 has
 * the six commentary rows at ordinals 2–7 inside its radius-10 window, so a context that
 * holds them spends read slots on rows no anchor count covers.
 */
const MIXED_NON_VERSE = 8;
const MIXED_VERSES = 40;
const MIXED_ANCHOR_ORDINAL = 12;
const MIXED_RADIUS = 10;
const MIXED_CAP = 2;
/** The commentary rows the anchor's window reaches — in context, never anchors. */
const MIXED_IN_CONTEXT_ORDINALS = [2, 3, 4, 5, 6, 7];

function mixedChildren(parentId: string, tag: string) {
  return Array.from({ length: MIXED_NON_VERSE + MIXED_VERSES }, (_, ordinal) => {
    const ayah = ordinal - MIXED_NON_VERSE + 1;
    return ordinal < MIXED_NON_VERSE
      ? {
          parentId,
          textRaw: `${tag}-comm-${ordinal}`,
          textAr: `${tag}-comm-${ordinal}`,
          textId: `${tag}-comm-id-${ordinal}`,
          citation: { sourceType: "tafsir", ordinal },
          embeddingPrimary: null,
          embeddingFallback: null,
          ordinal,
          metadata: { sourceType: "tafsir", citation: `Tafsir 3:${ordinal + 1}` },
        }
      : {
          parentId,
          textRaw: `${tag}-ar-${ordinal}`,
          textAr: `${tag}-ar-${ordinal}`,
          textId: `${tag}-id-${ordinal}`,
          citation: { sourceType: "quran", surah: 3, ayah },
          embeddingPrimary: null,
          embeddingFallback: null,
          ordinal,
          metadata: { sourceType: "quran", surah: 3, ayah, citation: `QS. 3:${ayah}` },
        };
  });
}

function routed(sourceText: string, subQueries: string[]): RoutedQuery<KajianQFilters> {
  return {
    intent: "factual",
    subQueries: subQueries.map((text) => ({ text })),
    filters: {},
    sourceText,
  };
}

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

    // The fused hit is 2:255; no scope expansion runs, because the question names no surah.
    expect(labelsOf(chunks.filter((c) => c.origin === undefined))).toEqual(["QS. 2:255"]);
    // Its OWN neighbours arrive: a parent-scoped opening read would have produced
    // 2:1..2:3 instead, which is what pins the anchor.
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
    // The event names the anchor the read was keyed on.
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
    // The caller's order IS the priority order: the read is keyed on it, and the cap
    // truncates the tail windows first.
    const result = await expand(store, [best, worse], { cap: 2 });
    expect(result.detail?.anchors).toEqual([best.id, worse.id]);
    expect(labelsOf(result.chunks).sort()).toEqual(["QS. 2:2", "QS. 2:4"]);
    expect(result.detail?.truncated).toBe(true);
  });

  it("budgets the cap for rows that reach the context and reports the truncation exactly", async () => {
    const store = createMemoryRagStore();
    await seedSurah(store, 2, 10, [4, 5]);
    const { retrieve, events, reads } = harness(store, { radius: 1, cap: 2, limit: 2 });
    const chunks = await retrieve(routed("Pertanyaan tanpa nama surah", ["generic question"]));
    // The two anchors are adjacent, so each appears inside the other's window and the
    // dedup drops it: the read gets one slot per anchor it can drop, plus the probe.
    expect(reads.lastLimit).toBe(2 + 2 + 1);
    expect(neighbourLabels(chunks).sort()).toEqual(["QS. 2:3", "QS. 2:6"]);
    const event = events.find((e) => e.kind === "neighbour_expansion") as
      | { detail: { returned: number; truncated: boolean; anchors: string[] } }
      | undefined;
    expect(event?.detail.returned).toBe(2);
    expect(event?.detail.truncated).toBe(false);
    expect(event?.detail.anchors).toHaveLength(2);
  });

  it("does not let a window full of anchors starve the cap: the trailing boundary verse arrives", async () => {
    const store = createMemoryRagStore();
    // ADR-0045's scope read is a contiguous `ORDER BY ordinal ASC LIMIT cap` window, so
    // a surah-naming question hands the expansion a page of adjacent verses as anchors.
    // Every anchor's window then holds other anchors — rows already in context — and the
    // one row the dedup cannot drop is the verse just past the page: the boundary address
    // a range extension wants.
    await seedSurah(store, 3, DEFAULT_NEIGHBOUR_CAP + 1);
    const rows = await Effect.runPromise(
      store.listDocChildrenByParentSourceKey(surahSourceKey(3), {
        limit: DEFAULT_NEIGHBOUR_CAP + 1,
      }),
    );
    const window = [...rows]
      .sort((a, b) => a.ordinal - b.ordinal)
      .slice(0, DEFAULT_NEIGHBOUR_CAP)
      .map((row) => chunkOf(row));
    const limits: number[] = [];
    const spy = {
      ...store,
      listDocChildNeighboursByChildIds(
        anchors: readonly string[],
        readOpts: { radius: number; limit: number },
      ) {
        limits.push(readOpts.limit);
        return store.listDocChildNeighboursByChildIds(anchors, readOpts);
      },
    };
    const result = await expand(spy, window, {
      radius: DEFAULT_NEIGHBOUR_RADIUS,
      cap: DEFAULT_NEIGHBOUR_CAP,
    });

    expect(result.detail?.anchors).toHaveLength(DEFAULT_NEIGHBOUR_CAP);
    expect(labelsOf(result.chunks)).toEqual([`QS. 3:${DEFAULT_NEIGHBOUR_CAP + 1}`]);
    expect(result.detail?.returned).toBeGreaterThan(0);
    expect(result.detail?.truncated).toBe(false);
    // One slot per row the dedup can drop — here, one per anchor — plus the probe.
    expect(limits).toEqual([DEFAULT_NEIGHBOUR_CAP + DEFAULT_NEIGHBOUR_CAP + 1]);
  });

  it("keeps the cap when the window holds rows that are not verses", async () => {
    const store = createMemoryRagStore();
    // A parent is not all anchors: a commentary row inside a verse anchor's window is in
    // context without being a verse, so it spends a read slot the anchor count misses.
    // The bound is the whole in-context set, not the anchors among it.
    const parentId = await Effect.runPromise(
      store.insertDocParent({
        sourceKey: "mixed/3",
        title: "QS. 3 (mixed)",
        metadata: { sourceType: "quran", surah: 3 },
      }),
    );
    await Effect.runPromise(store.insertDocChildren(mixedChildren(parentId, "mem")));
    const rows = await Effect.runPromise(
      store.listDocChildrenByParentSourceKey("mixed/3", {
        limit: MIXED_NON_VERSE + MIXED_VERSES,
      }),
    );
    const at = (ordinal: number) => {
      const row = rows.find((r) => r.ordinal === ordinal);
      if (row === undefined) throw new Error(`no mixed row at ordinal ${ordinal}`);
      return row;
    };
    const result = await expand(
      store,
      [
        chunkOf(at(MIXED_ANCHOR_ORDINAL)),
        ...MIXED_IN_CONTEXT_ORDINALS.map((ordinal) => chunkOf(at(ordinal))),
      ],
      { radius: MIXED_RADIUS, cap: MIXED_CAP },
    );

    // Ordinals 8 and 9 are the first two neighbours the context does not hold; the six
    // commentary rows read before them are dropped, and no longer pass for the budget.
    expect(labelsOf(result.chunks)).toEqual(["QS. 3:1", "QS. 3:2"]);
    expect(result.detail?.returned).toBe(MIXED_CAP);
    expect(result.detail?.truncated).toBe(true);
  });

  it("does not add a neighbour that is already a fused hit or a scope chunk", async () => {
    const store = await baqarah();
    // 2:255 arrives as a fused hit and 2:256 as a scope chunk: both are already in
    // context, so neither is added twice and `returned` counts only the addition.
    const already: Chunk[] = [
      chunkOf(await rowOf(store, 2, 255)),
      chunkOf(await rowOf(store, 2, 256), SCOPE_EXPANSION_ORIGIN),
    ];
    const result = await expand(store, already, { radius: 1, cap: 12 });
    expect(labelsOf(result.chunks).sort()).toEqual(["QS. 2:254", "QS. 2:257"]);
    expect(result.chunks.every((c) => c.origin === NEIGHBOUR_EXPANSION_ORIGIN)).toBe(true);
    expect(result.detail?.returned).toBe(2);
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
    // With no verse to anchor on, the expansion costs no round trip and records nothing.
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
 * The acceptance boundary: the **assembled context** the gate actually reads, not
 * a hand-built list.
 */
describe("the assembled context grounds the real failing label (#274)", () => {
  async function alImran(opts: { radius?: number } = {}): Promise<{
    chunks: readonly Chunk[];
    context: string;
  }> {
    const store = createMemoryRagStore();
    await seedSurah(store, 3, 200, [2]);
    const { retrieve } = harness(store, { limit: 1, ...opts });
    const chunks = await retrieve(
      routed("Apa maksud Ayat Kursi?", ["makna ayat kursi", "tafsir ayat kursi"]),
    );
    // The real assembler, whose `RunContext` requirement the runner supplies in production.
    const assembled = Effect.runSync(
      createKajianQAssembler().assemble(routedQuery("Apa maksud Ayat Kursi?"), chunks) as never,
    ) as {
      chunks: readonly Chunk[];
      turns: readonly { content: string }[];
    };
    return {
      chunks: assembled.chunks,
      context: assembled.turns.map((turn) => turn.content).join("\n"),
    };
  }

  it("puts QS. 3:1 in the assembled context, so the range grounds", async () => {
    const { chunks, context } = await alImran();
    expect(labelsOf(chunks)).toContain("QS. 3:2");
    expect(labelsOf(chunks)).toContain("QS. 3:1");
    expect(context).toContain("[QS. 3:1]");
    expect(context).toContain("[QS. 3:2]");
    expect(validateCitations("Dalilnya QS. 3:1-2 tentang hal ini", chunks).ungrounded).toEqual([]);
  });

  it("still refuses a range with no retrieved member, and a single fabricated verse", async () => {
    const { chunks } = await alImran();
    // No member of this range is in the context (surah 9 is not in the corpus).
    expect(validateCitations("Dalilnya QS. 9:99-100", chunks).ungrounded).toEqual(["QS. 9:99-100"]);
    expect(validateCitations("Dalilnya QS. 9:99", chunks).ungrounded).toEqual(["QS. 9:99"]);
    // A range reaching past the neighbourhood window asserts grounding it lacks.
    expect(validateCitations("Dalilnya QS. 3:1-5", chunks).ungrounded).toEqual(["QS. 3:1-5"]);
  });

  it("is falsifiable: the same pipeline with the expansion disabled reddens the row", async () => {
    // The named mutation: NEIGHBOUR_EXPANSION_RADIUS=0 (the documented disable).
    // Everything else is identical, so the row that moves is the expansion's own.
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

/**
 * The same expansion against the read that EXECUTES it — the memory store above mirrors
 * the Postgres adapter's per-anchor contract, and this block holds the two to it on the
 * window that starved the cap. Like the adapter's own contract suite it needs a real
 * server: it runs when `DATABASE_URL` is set and is skipped without it.
 */
const PG_URL = process.env.DATABASE_URL;
const pgRun = PG_URL ? describe : describe.skip;

pgRun("the anchored neighbour read on real Postgres (ADR-0049)", () => {
  const RADIUS = 1;
  const CAP = DEFAULT_NEIGHBOUR_CAP;
  /** The page, plus the boundary verse the page stops short of. */
  const VERSES = CAP + 1;
  let prefix = "";
  let sql: ReturnType<typeof postgresSqlRunner> | null = null;
  let store: ReturnType<typeof createPostgresRagStore> | null = null;
  /** ADR-0045's scope window: the surah's first `cap` verses, verbatim. */
  let window: Chunk[] = [];
  let boundaryLabel = "";

  beforeAll(async () => {
    if (!PG_URL) return;
    prefix = `ct-neigh-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    sql = postgresSqlRunner(postgresPool(PG_URL));
    store = createPostgresRagStore(sql);
    const parentId = await Effect.runPromise(
      store.insertDocParent({
        sourceKey: prefix,
        title: prefix,
        metadata: { sourceType: "quran", surah: 3 },
      }),
    );
    await Effect.runPromise(
      store.insertDocChildren(
        Array.from({ length: VERSES }, (_, i) => ({
          parentId,
          textRaw: `raw-${prefix}-${i}`,
          textAr: `ar-${prefix}-${i}`,
          textId: `id-${prefix}-${i}`,
          citation: { sourceType: "quran", surah: 3, ayah: i + 1 },
          embeddingPrimary: null,
          embeddingFallback: null,
          ordinal: i,
          metadata: { sourceType: "quran", surah: 3, ayah: i + 1, citation: `QS. 3:${i + 1}` },
        })),
      ),
    );
    const rows = await Effect.runPromise(
      store.listDocChildrenByParentSourceKey(prefix, { limit: VERSES }),
    );
    const ordered = [...rows].sort((a, b) => a.ordinal - b.ordinal);
    window = ordered
      .slice(0, CAP)
      .map((row) => ({ id: row.id, text: row.textAr, metadata: row.metadata }));
    boundaryLabel = ordered[CAP]?.metadata["citation"] as string;
    const mixedParentId = await Effect.runPromise(
      store.insertDocParent({
        sourceKey: `${prefix}-mixed`,
        title: `${prefix}-mixed`,
        metadata: { sourceType: "quran", surah: 3 },
      }),
    );
    await Effect.runPromise(store.insertDocChildren(mixedChildren(mixedParentId, prefix)));
  });

  afterAll(async () => {
    if (!PG_URL || sql === null) return;
    // Exact keys, so the shared database keeps only the rows this block owns.
    await sql`DELETE FROM doc_children WHERE parent_id IN (
      SELECT id FROM doc_parents WHERE source_key IN (${prefix}, ${`${prefix}-mixed`})
    )`;
    await sql`DELETE FROM doc_parents WHERE source_key IN (${prefix}, ${`${prefix}-mixed`})`;
    await disposePostgresPools();
  });

  it("spends the cap-plus-one read on rows the context already holds", async () => {
    if (store === null) return;
    const rows = await Effect.runPromise(
      store.listDocChildNeighboursByChildIds(
        window.map((c) => c.id),
        { radius: RADIUS, limit: CAP + 1 },
      ),
    );
    const inContext = new Set(window.map((c) => c.id));
    // Per-anchor windows overlap, so all but one slot goes to an anchor the dedup then
    // drops, and the boundary verse sorts last — out of reach of a `cap + 1` read.
    expect(rows.length).toBe(CAP + 1);
    expect(rows.filter((r) => !inContext.has(r.id)).map((r) => r.metadata["citation"])).toEqual([
      boundaryLabel,
    ]);
  });

  it("adds the boundary verse the cap-plus-one read cannot reach", async () => {
    if (store === null) return;
    const result = await Effect.runPromise(
      expandVerseNeighbours({
        retrieved: window,
        radius: RADIUS,
        cap: CAP,
        store,
        bridge: (effect) => Effect.runPromise(effect),
      }),
    );
    expect(labelsOf(result.chunks)).toEqual([boundaryLabel]);
    expect(result.detail?.returned).toBe(1);
    expect(result.detail?.truncated).toBe(false);
  });

  it("counts the non-verse rows in context, so the window's verses still arrive", async () => {
    if (store === null) return;
    const rows = await Effect.runPromise(
      store.listDocChildrenByParentSourceKey(`${prefix}-mixed`, {
        limit: MIXED_NON_VERSE + MIXED_VERSES,
      }),
    );
    const at = (ordinal: number) => {
      const row = rows.find((r) => r.ordinal === ordinal);
      if (row === undefined) throw new Error(`no mixed row at ordinal ${ordinal}`);
      return row;
    };
    const chunkAt = (ordinal: number) => {
      const row = at(ordinal);
      return { id: row.id, text: row.textAr, metadata: row.metadata };
    };
    const result = await Effect.runPromise(
      expandVerseNeighbours({
        retrieved: [chunkAt(MIXED_ANCHOR_ORDINAL), ...MIXED_IN_CONTEXT_ORDINALS.map(chunkAt)],
        radius: MIXED_RADIUS,
        cap: MIXED_CAP,
        store,
        bridge: (effect) => Effect.runPromise(effect),
      }),
    );
    // The read's per-anchor answer is unchanged; the caller's bound now covers the
    // commentary rows the context holds, which are the rows the anchor count missed.
    expect(labelsOf(result.chunks)).toEqual(["QS. 3:1", "QS. 3:2"]);
    expect(result.detail?.returned).toBe(MIXED_CAP);
    expect(result.detail?.truncated).toBe(true);
  });
});
