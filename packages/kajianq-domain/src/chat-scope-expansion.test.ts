import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { RunContext, type Chunk, type RoutedQuery } from "@app/rag-core";
import { createKajianQRetriever } from "./chat-retriever";
import { runChatPipeline } from "./chat-pipeline";
import { DEFAULT_SCOPE_EXPANSION_CAP, SCOPE_EXPANSION_ORIGIN } from "./chat-scope-expansion";
import { RETRIEVED_SCOPE_KEY } from "./chat-surah-completion";
import type { KajianQFilters } from "./filters";
import { surahSourceKey } from "./quran-source";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";
import { createStubChatProviders } from "./test-utils/stub-chat-providers";

/**
 * Surah-reference scoped expansion (ADR-0045) — the retrieval behaviour.
 *
 * The invariant under test: a question that names a surah retrieves that surah's
 * children **deterministically and bounded**, alongside (never instead of) the
 * fused hits; a question that names no surah retrieves nothing extra and does not
 * read the store; and the result does not depend on the router's paraphrase,
 * because the scope is detected on the verbatim question.
 */

const COST = { modelId: "stub-embedder", tokensIn: 1, tokensOut: 1, latencyMs: 1, costMicroUsd: 0 };

/** The query vector: close to the hadith track, far from the Quran track. */
const QUERY_VEC = [1, 0];
const HADITH_VEC = [1, 0];
const QURAN_VEC = [0, 1];

const GS_V0_015 = "What does Surah Al-Fatihah mean and why is it recited in every prayer?";
const FAILING_SUB_QUERIES = [
  "tafsir of Surah Al-Fatihah meaning and virtues",
  "تفسير سورة الفاتحة معانيها وفضلها",
];
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
        // Far from the query vector and unembedded on the fallback track, so the
        // fused retrieval returns none of them.
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
  reads: { count: number; lastLimit: number; lastFromOrdinal: number | undefined };
} {
  const events: Recorded[] = [];
  const reads = { count: 0, lastLimit: 0, lastFromOrdinal: undefined as number | undefined };
  const spy = {
    ...store,
    listDocChildrenByParentSourceKey(
      parentSourceKey: string,
      opts: { limit: number; fromOrdinal?: number },
    ) {
      reads.count += 1;
      reads.lastLimit = opts.limit;
      reads.lastFromOrdinal = opts.fromOrdinal;
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

describe("surah scoped expansion", () => {
  it("adds the named surah's children alongside the fused hits", async () => {
    const { store, hadithId } = await corpus();
    const { retrieve } = harness(store);
    const chunks = await retrieve(routed(GS_V0_015, FAILING_SUB_QUERIES));

    expect(chunks.some((c) => c.id === hadithId)).toBe(true);
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
    // Deterministic window: the surah's opening, in the corpus's ordinal order.
    expect(expansion.map((c) => (c.metadata ?? {})["citation"])).toEqual(
      Array.from({ length: cap }, (_, i) => `QS. 2:${i + 1}`),
    );
    // The read probes one past the cap — the exact truncation signal.
    expect(reads.lastLimit).toBe(cap + 1);
    // A surah reference (no verse) reads the parent's opening: no lower bound.
    expect(reads.lastFromOrdinal).toBeUndefined();
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

  it("anchors the window on a named verse past the opening window", async () => {
    const { store } = await corpus();
    const cap = 12;
    const { retrieve, events, reads } = harness(store, cap);
    const chunks = await retrieve(routed("Apa makna QS. 2:255?", ["makna ayat kursi"]));

    // The named verse sets where the window starts, so a reference past the
    // opening is supplied by the deterministic read rather than by the fused
    // tracks.
    expect(reads.lastFromOrdinal).toBe(254);
    expect(reads.lastLimit).toBe(cap + 1);
    expect(labels(chunks.filter((c) => c.origin === SCOPE_EXPANSION_ORIGIN))).toEqual(
      Array.from({ length: cap }, (_, i) => `QS. 2:${255 + i}`),
    );
    const event = events.find((e) => e.kind === "scope_expansion") as
      | {
          detail: { returned: number; cap: number; truncated: boolean; key: string; value: string };
        }
      | undefined;
    expect(event?.detail).toEqual({
      key: "surah",
      value: "2:255",
      returned: cap,
      cap,
      truncated: true,
    });
  });

  it("returns a short verse-anchored window when the surah ends there", async () => {
    const { store } = await corpus();
    const { retrieve, events } = harness(store, 12);
    // The last verse of Al-Baqarah: the window cannot reach the cap, and that is
    // not truncation — the parent simply ends.
    const chunks = await retrieve(routed("Apa makna QS. 2:286?", ["makna akhir al-baqarah"]));
    expect(labels(chunks.filter((c) => c.origin === SCOPE_EXPANSION_ORIGIN))).toEqual([
      "QS. 2:286",
    ]);
    const event = events.find((e) => e.kind === "scope_expansion") as
      | { detail: { returned: number; truncated: boolean; value: string } }
      | undefined;
    expect(event?.detail).toEqual(
      expect.objectContaining({ value: "2:286", returned: 1, truncated: false }),
    );
  });

  it("adds no read for a description a natural qualifier moves", async () => {
    const { store } = await corpus();
    const { retrieve, events, reads } = harness(store);
    // The table carries no phrase: a positional description under a
    // revelation-order qualifier names Al-Alaq, not Al-Fatihah, so the read must
    // not fire — a wrong deterministic read is the failure this table exists to
    // prevent.
    for (const question of [
      "Which was the first surah of the Quran to be revealed?",
      "Which is the opening chapter of the Quran in the order of revelation?",
    ]) {
      const chunks = await retrieve(routed(question, ["first revealed surah"]));
      expect(
        chunks.every((c) => c.origin !== SCOPE_EXPANSION_ORIGIN),
        question,
      ).toBe(true);
      expect(
        events.filter((e) => e.kind === "scope_expansion"),
        question,
      ).toHaveLength(0);
      expect(reads.count, question).toBe(0);
    }
  });

  it("does not expand a description the curated table does not carry", async () => {
    const { store } = await corpus();
    const { retrieve, events, reads } = harness(store);
    const chunks = await retrieve(
      routed("What does the surah that begins with praise mean?", ["surah beginning with praise"]),
    );
    expect(chunks.every((c) => c.origin !== SCOPE_EXPANSION_ORIGIN)).toBe(true);
    expect(events.filter((e) => e.kind === "scope_expansion")).toHaveLength(0);
    expect(reads.count).toBe(0);
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
    await seedHadith(store);
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
    expect(qs11).toHaveLength(1);
    expect(qs11[0]?.origin).toBeUndefined();
    const event = events.find((e) => e.kind === "scope_expansion") as
      | { detail: { returned: number } }
      | undefined;
    expect(event?.detail.returned).toBe(6);
    expect(chunks.filter((c) => c.origin === SCOPE_EXPANSION_ORIGIN)).toHaveLength(6);
  });
});

/**
 * Expansion must be word-for-word identical across the failing and passing
 * sub-query sets, and must survive a paraphrase that does not name the surah: the
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

  it("does not expand when only the sub-queries name a surah (C2's asymmetric negative)", async () => {
    // The question names no surah, so no scope may be read even though a sub-query
    // names one loudly — a sub-query-keyed implementation cannot pass this.
    const { store } = await corpus();
    const { retrieve, events, reads } = harness(store);
    const chunks = await retrieve(
      routed("What is the ruling on praying in a garment that contains gold?", [
        "tafsir of Surah Al-Fatihah meaning and virtues",
      ]),
    );
    expect(chunks.every((c) => c.origin !== SCOPE_EXPANSION_ORIGIN)).toBe(true);
    expect(events.filter((e) => e.kind === "scope_expansion")).toHaveLength(0);
    // The read must not happen at all — detection is the gate, not a filter applied
    // after the store round trip.
    expect(reads.count).toBe(0);
  });
});

/**
 * An expansion that left no record would be a silent retrieval path. This runs the
 * real `runChatPipeline` runner, which parses collected events into the shared
 * `Trace` contract, so a malformed event fails the run.
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
          // A fused set that misses Al-Fatihah entirely, so the expansion is visibly what adds it.
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

/**
 * Short-surah completion — ADR-0045's second trigger. A fused verse of a surah
 * that fits the budget pulls that surah's remaining children from the opening,
 * which is where the verse that answers the question can sit; a long surah, a
 * spent budget or a disabled cap adds nothing.
 */

async function seedRetrievedVerse(
  store: ReturnType<typeof createMemoryRagStore>,
  surah: number,
  ayahCount: number,
  retrievedAyah: number,
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
      Array.from({ length: ayahCount }, (_, i) => ({
        parentId,
        textRaw: `ar-${surah}:${i + 1}`,
        textAr: `ar-${surah}:${i + 1}`,
        textId: `id-${surah}:${i + 1}`,
        citation: { sourceType: "quran", surah, ayah: i + 1 },
        // One verse carries the query's vector, so fusion returns it; the rest of
        // the surah is far from the query and never competes.
        embeddingPrimary: i + 1 === retrievedAyah ? HADITH_VEC : QURAN_VEC,
        embeddingFallback: i + 1 === retrievedAyah ? HADITH_VEC : QURAN_VEC,
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
}

// The recorded-run question whose required verse is the Basmalah the fused tracks
// never returned: it names no surah, so only the completion trigger can add it.
const ASMAUL_HUSNA = "Apa makna asmaul husna Ar-Rahman dan Ar-Rahim?";

describe("short-surah completion", () => {
  it("adds the opening verse of the short surah a fused verse belongs to", async () => {
    const store = createMemoryRagStore();
    await seedRetrievedVerse(store, 1, 7, 3);
    const { retrieve, events, reads } = harness(store);
    const chunks = await retrieve(routed(ASMAUL_HUSNA, ["makna ar-rahman dan ar-rahim"]));

    // The fused tracks returned the surah's third verse and nothing of the rest.
    expect(labels(chunks)).toEqual(
      expect.arrayContaining(["QS. 1:1", "QS. 1:2", "QS. 1:3", "QS. 1:4", "QS. 1:7"]),
    );
    const completion = chunks.filter((c) => c.origin === SCOPE_EXPANSION_ORIGIN);
    expect(labels(completion)).toEqual([
      "QS. 1:1",
      "QS. 1:2",
      "QS. 1:4",
      "QS. 1:5",
      "QS. 1:6",
      "QS. 1:7",
    ]);
    expect(reads.count).toBe(1);
    expect(reads.lastFromOrdinal).toBeUndefined();
    expect(events.filter((e) => e.kind === "scope_expansion")).toEqual([
      {
        stage: "retriever",
        kind: "scope_expansion",
        detail: {
          key: RETRIEVED_SCOPE_KEY,
          value: "1",
          returned: 6,
          cap: DEFAULT_SCOPE_EXPANSION_CAP,
          truncated: false,
        },
        at: 1,
      },
    ]);
  });

  it("leaves a retrieved long surah alone (no read, no event)", async () => {
    const store = createMemoryRagStore();
    await seedRetrievedVerse(store, 2, 286, 255);
    const { retrieve, events, reads } = harness(store);
    const chunks = await retrieve(routed(ASMAUL_HUSNA, ["makna asmaul husna"]));

    expect(chunks.every((c) => c.origin !== SCOPE_EXPANSION_ORIGIN)).toBe(true);
    expect(events.filter((e) => e.kind === "scope_expansion")).toHaveLength(0);
    expect(reads.count).toBe(0);
  });

  it("spends what the named read left and completes the verse before the named one", async () => {
    const store = createMemoryRagStore();
    await seedRetrievedVerse(store, 1, 7, 3);
    const { retrieve, events } = harness(store);
    const chunks = await retrieve(routed("Apa makna QS. 1:3?", ["makna ayat"]));

    const scopeEvents = events.filter((e) => e.kind === "scope_expansion") as {
      detail: { key: string; value: string; returned: number; cap: number };
    }[];
    expect(scopeEvents.map((e) => e.detail)).toEqual([
      {
        key: "surah",
        value: "1:3",
        returned: 4,
        cap: DEFAULT_SCOPE_EXPANSION_CAP,
        truncated: false,
      },
      {
        key: RETRIEVED_SCOPE_KEY,
        value: "1",
        returned: 2,
        cap: DEFAULT_SCOPE_EXPANSION_CAP - 4,
        truncated: false,
      },
    ]);
    expect(labels(chunks)).toEqual(
      expect.arrayContaining(["QS. 1:1", "QS. 1:2", "QS. 1:3", "QS. 1:4", "QS. 1:7"]),
    );
  });

  it("issues no completion read when the cap disables the surah reads", async () => {
    const store = createMemoryRagStore();
    await seedRetrievedVerse(store, 1, 7, 3);
    const { retrieve, events, reads } = harness(store, 0);
    const chunks = await retrieve(routed(ASMAUL_HUSNA, ["makna ar-rahman dan ar-rahim"]));

    expect(chunks.every((c) => c.origin !== SCOPE_EXPANSION_ORIGIN)).toBe(true);
    expect(events.filter((e) => e.kind === "scope_expansion")).toHaveLength(0);
    expect(reads.count).toBe(0);
  });
});

describe("the completion on the persisted answer trace", () => {
  it("puts the completion's chunks on the retrieval event, under its own scope key", async () => {
    const store = createMemoryRagStore();
    await seedRetrievedVerse(store, 1, 7, 3);
    const answer = await Effect.runPromise(
      runChatPipeline(
        {
          ...createStubChatProviders({ answerText: "Jawaban berdasar konteks." }),
          store: store as never,
          bridge: (e) => Effect.runPromise(e as never),
          language: "en",
          retrieverLimit: 1,
        },
        { text: ASMAUL_HUSNA },
      ) as never,
    );
    const trace = (answer as { trace: { events: Recorded[] } }).trace;
    const retrieval = trace.events.find((e) => e.kind === "retrieval") as
      | { detail: { chunks: { id: string; origin?: string }[] } }
      | undefined;
    const refs = retrieval?.detail.chunks ?? [];
    // The fused verse plus its surah's six other verses, all on the trace.
    expect(refs).toHaveLength(7);
    expect(refs.filter((c) => c.origin === SCOPE_EXPANSION_ORIGIN)).toHaveLength(6);
    const completion = trace.events.filter(
      (e) =>
        e.kind === "scope_expansion" &&
        (e.detail as { key?: string } | undefined)?.key === RETRIEVED_SCOPE_KEY,
    );
    expect(completion).toHaveLength(1);
  });
});
