import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { CALLER_PRIORITY_K } from "@app/contracts";
import {
  RunContext,
  type ChoiceAnswer,
  type Chunk,
  type Decider,
  type RoutedQuery,
} from "@app/rag-core";
import { createKajianQAssembler } from "./chat-assembler";
import {
  CALLER_PRIORITY_ORIGIN,
  callerIndexIn,
  guaranteeCallerPriority,
  isCallerSubQuery,
  type RetrieverStore,
  type TrackHit,
} from "./chat-retriever-parts";
import { createChatRetriever } from "./chat-retrieval-stages";
import type { KajianQFilters } from "./filters";
import { routedQuery } from "./test-utils/routed-query";

/**
 * Caller-query priority (ADR-0062): the caller's own question is the one query
 * guaranteed to be in the user's vocabulary, so its leading dense hits are a
 * retrieval angle of their own. Fusion weighs every list alike and the router's
 * paraphrases outnumber the caller's single list, so this test makes the
 * paraphrase rows outscore the caller's rank-2 row on every list — and pins
 * that the row still leads the assembled context, under its own label, in the
 * order the caller's own words ranked it.
 */

const cost = { modelId: "m", tokensIn: 1, tokensOut: 1, latencyMs: 1, costMicroUsd: 1 };

const TARGET = "ibnu-majah-224";
/** The caller's own dense list: the target sits at rank 2, on both tracks. */
const CALLER_ROWS = ["caller-1", TARGET, "caller-3"];
/** Rows only the paraphrases return — six lists' worth, so they outvote the caller. */
const PARAPHRASE_ROWS = ["p1", "p2", "p3", "p4", "p5", "p6"];

const CALLER_TEXT = "apa keutamaan menuntut ilmu";
/** The caller's own sub-query, as the decomposition repair labels it. */
const CALLER_SUB_QUERY = { text: CALLER_TEXT, role: "factual", origin: "rule" };
const SUB_QUERIES = [
  CALLER_SUB_QUERY,
  { text: "hadits keutamaan menuntut ilmu", role: "factual", origin: "model" },
  { text: "dalil tentang keutamaan ilmu", role: "dalil", origin: "model" },
  { text: "sanad hadits keutamaan ilmu", role: "sanad", origin: "model" },
];

const child = (id: string) => ({
  id,
  textAr: `arab-${id}`,
  textId: `id-${id}`,
  metadata: { sourceType: "hadith", collection: "ibnmajah" },
});

const ranked = (ids: readonly string[]) =>
  ids.map((id, index) => ({ child: child(id), distance: 0.1 + index / 100, rankDense: index + 1 }));

/** The caller's sub-query embeds to [1, 0]; every paraphrase to [0, 1]. */
const isCallerVector = (embedding: readonly number[]) => embedding[0] === 1;

type SearchCall = { track: "primary" | "fallback"; limit: number };

function makeStore() {
  const calls: SearchCall[] = [];
  const store = {
    similaritySearch: (
      track: "primary" | "fallback",
      embedding: readonly number[],
      o: { limit: number },
    ) => {
      calls.push({ track, limit: o.limit });
      return Effect.succeed(ranked(isCallerVector(embedding) ? CALLER_ROWS : PARAPHRASE_ROWS));
    },
    listDocChildrenByParentSourceKey: () => Effect.succeed([]),
    listDocChildNeighboursByChildIds: () => Effect.succeed([]),
    findDocChildrenByMetadata: () => Effect.succeed([]),
  };
  return { store: store as unknown as RetrieverStore, calls };
}

type Recorded = { kind: string; detail?: unknown; cost?: { modelId?: string } };

/** The retriever's deps without the rerank role: the wired stage supplies that. */
function retrieverDeps(
  store: RetrieverStore,
  embed: (texts: readonly string[]) => void = () => {},
) {
  return {
    store,
    embedder: {
      embed: ({ texts }: { texts: readonly string[]; personalData: true }) => {
        embed(texts);
        return Effect.succeed({
          // The caller's rows are keyed on the caller's own words, however the
          // fixture's producer padded them: this picks the store's caller list, not
          // the admission under test.
          vectors: texts.map((text) => (text.trim() === CALLER_TEXT ? [1, 0] : [0, 1])),
          cost,
        });
      },
    },
    bridge: ((e: unknown) => Effect.runPromise(e as never)) as never,
    limit: 10,
  };
}

function run(
  options: {
    subQueries?: { text: string; role?: string; origin?: string }[];
    /** Overrides the verbatim text the route stamps beside its sub-queries. */
    sourceText?: string;
    decider?: Decider;
    callerPriorityK?: number;
    /** The store the route searches, for a fixture the shared one cannot shape. */
    store?: RetrieverStore;
    record?: (event: Recorded) => void;
  } = {},
): Promise<{ chunks: readonly Chunk[]; events: Recorded[] }> {
  const store = options.store ?? makeStore().store;
  const events: Recorded[] = [];
  // The wired stage, not the bare retriever: this is where the rerank composes,
  // and the guarantee's effect on it is part of what the tests pin.
  const retriever = createChatRetriever({
    ...retrieverDeps(store),
    rerankDecider: options.decider ?? null,
    ...(options.callerPriorityK !== undefined ? { callerPriorityK: options.callerPriorityK } : {}),
  });
  const routed = routedQuery(options.sourceText ?? CALLER_TEXT, {
    subQueries: options.subQueries ?? SUB_QUERIES,
  });
  return Effect.runPromise(
    Effect.provideService(retriever.retrieve(routed as never), RunContext, {
      config: {},
      now: () => 7,
      record: (event: unknown) => {
        events.push(event as Recorded);
        options.record?.(event as Recorded);
      },
    } as never) as never,
  ).then((chunks) => ({ chunks: chunks as readonly Chunk[], events }));
}

/** The assembled context the generator actually reads. */
function assemble(
  chunks: readonly Chunk[],
  routed: RoutedQuery<KajianQFilters> = routedQuery(CALLER_TEXT, { subQueries: SUB_QUERIES }),
): readonly Chunk[] {
  const context = Effect.runSync(createKajianQAssembler().assemble(routed, chunks) as never) as {
    chunks: readonly Chunk[];
  };
  return context.chunks;
}

/** A decider answering one Choice question with the given probabilities. */
function answering(probabilities: readonly number[]): { decider: Decider; specs: unknown[] } {
  const specs: unknown[] = [];
  const answer: ChoiceAnswer = {
    type: "choice",
    choice: `c${probabilities.indexOf(Math.max(...probabilities))}`,
    probabilities: Object.fromEntries(probabilities.map((p, i) => [`c${i}`, p])),
    confidence: 1,
  };
  const decider: Decider = {
    modelId: "test-decider",
    decide: (spec) => {
      specs.push(spec);
      return Effect.succeed({
        answers: { best: answer },
        cost: { ...cost, modelId: "test-decider" },
      });
    },
  };
  return { decider, specs };
}

describe("the caller's own query is a priority retrieval angle", () => {
  it("leads the returned set with the caller's rank-2 row under its own label", async () => {
    const { chunks } = await run();

    // The paraphrase rows appear in every paraphrase list, so fusion alone puts
    // all six ahead of the caller's rank-2 row on equal scores and id order; the
    // guarantee is what leads the set with the caller's own order.
    expect(chunks.map((chunk) => chunk.id)).toEqual([...CALLER_ROWS, ...PARAPHRASE_ROWS]);
    const target = chunks.find((chunk) => chunk.id === TARGET);
    expect(target).toBeDefined();
    expect(target?.origin).toBe(CALLER_PRIORITY_ORIGIN);
    // Only the caller's leading hits are guaranteed; the rest keep the fused order.
    expect(chunks.filter((chunk) => chunk.origin === CALLER_PRIORITY_ORIGIN)).toHaveLength(
      CALLER_PRIORITY_K,
    );
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
  });

  it("records the bound, the guaranteed ids, and how much was already present", async () => {
    const { chunks, events } = await run();
    const event = events.find((entry) => entry.kind === "caller_priority");
    expect(event?.detail).toEqual({
      k: CALLER_PRIORITY_K,
      ids: CALLER_ROWS,
      // Every search hit reaches fusion, so the guarantee promotes rather than adds.
      alreadyPresent: CALLER_ROWS,
    });
    expect(JSON.stringify(event?.detail)).not.toContain("arab-");
    expect(chunks).toHaveLength(3 + PARAPHRASE_ROWS.length);
  });
});

/**
 * The selection rule itself: both texts pass `admitSubQueryText`, so "the same
 * query" is the accepted text and padding on either side is not a difference.
 * The route tests below cover the same rule end to end; these pin it at the
 * unit and give `callerIndexIn` a direct target.
 */
describe("the caller's entry is selected by the admitted text", () => {
  it.each([
    ["both sides as written", "apa hukumnya", "apa hukumnya"],
    ["the caller's text padded", `  apa hukumnya\n`, "apa hukumnya"],
    ["the entry's text padded", "apa hukumnya", `  apa hukumnya\n`],
    ["both sides padded", ` apa hukumnya `, "\napa hukumnya  "],
  ])("selects the entry when %s", (_case, callerText, entryText) => {
    expect(isCallerSubQuery({ text: entryText }, callerText)).toBe(true);
  });

  it("rejects a different question, a content-free entry, and a content-free question", () => {
    expect(isCallerSubQuery({ text: "makna ayat kursi" }, "apa hukumnya")).toBe(false);
    expect(isCallerSubQuery({ text: " \n " }, "apa hukumnya")).toBe(false);
    expect(isCallerSubQuery({ text: "apa hukumnya" }, " \n ")).toBe(false);
  });

  it("resolves the caller's index among paraphrase entries, and -1 when absent", () => {
    const paraphrase = { text: "makna ayat kursi" };
    expect(callerIndexIn([paraphrase, { text: ` ${CALLER_TEXT} ` }, paraphrase], CALLER_TEXT)).toBe(
      1,
    );
    expect(callerIndexIn([paraphrase], CALLER_TEXT)).toBe(-1);
    expect(callerIndexIn([], CALLER_TEXT)).toBe(-1);
  });
});

/**
 * The shared fixture (`test-utils/routed-query.ts`) is the decomposition repair's
 * route: its one entry is `rule`/`factual` and carries the caller's question, so
 * a suite that takes the default is running the guarantee, not beside it.
 */
describe("the shared routed-query default is a route the guarantee covers", () => {
  it("records the caller's entry with production's provenance and fires the guarantee", async () => {
    const { store } = makeStore();
    const events: Recorded[] = [];
    const retriever = createChatRetriever({ ...retrieverDeps(store), rerankDecider: null });
    const chunks = (await Effect.runPromise(
      Effect.provideService(retriever.retrieve(routedQuery(CALLER_TEXT) as never), RunContext, {
        config: {},
        now: () => 7,
        record: (event: unknown) => events.push(event as Recorded),
      } as never) as never,
    )) as readonly Chunk[];

    const searches = events.filter((event) => event.kind === "search_hits");
    expect(searches.map((event) => event.detail)).toMatchObject([
      { role: "factual", origin: "rule", track: "primary" },
      { role: "factual", origin: "rule", track: "fallback" },
    ]);
    expect(events.some((event) => event.kind === "caller_priority")).toBe(true);
    expect(chunks.every((chunk) => chunk.origin === CALLER_PRIORITY_ORIGIN)).toBe(true);
  });
});

/**
 * The router's fallback route: the only sub-query carries the caller's words with
 * `origin: "fallback"`. The corpus rows are shaped so the caller's rank-2 hit sits
 * on the primary track alone — the fallback track never returned it, so no other
 * list can lift it and fusion puts a row both tracks returned ahead of it.
 */
const FALLBACK_SUB_QUERIES = [{ text: CALLER_TEXT, role: "factual", origin: "fallback" }];
const FALLBACK_PRIMARY_ROWS = ["p1", TARGET, "p2"];
const FALLBACK_TRACK_ROWS = ["p1", "p2", "p3"];

function makeFallbackStore(): RetrieverStore {
  const store = {
    similaritySearch: (track: "primary" | "fallback") =>
      Effect.succeed(ranked(track === "primary" ? FALLBACK_PRIMARY_ROWS : FALLBACK_TRACK_ROWS)),
    listDocChildrenByParentSourceKey: () => Effect.succeed([]),
    listDocChildNeighboursByChildIds: () => Effect.succeed([]),
    findDocChildrenByMetadata: () => Effect.succeed([]),
  };
  return store as unknown as RetrieverStore;
}

describe("the guarantee covers the router's fallback route", () => {
  it("leads the returned set with the caller's rank-2 hit no other list carries", async () => {
    const { chunks } = await run({
      subQueries: FALLBACK_SUB_QUERIES,
      store: makeFallbackStore(),
    });

    // Fusion alone puts p2 — a row both tracks returned — ahead of the caller's
    // rank-2 hit, and the fallback track never returned the hit, so no other list
    // can rescue it. The guarantee is what leads the set with the caller's order.
    expect(chunks.map((chunk) => chunk.id)).toEqual(["p1", TARGET, "p2", "p3"]);
    expect(chunks[1]?.id).toBe(TARGET);
    expect(chunks[1]?.origin).toBe(CALLER_PRIORITY_ORIGIN);
    expect(
      chunks.filter((chunk) => chunk.origin === CALLER_PRIORITY_ORIGIN).map((chunk) => chunk.id),
    ).toEqual(["p1", TARGET, "p2"]);
  });

  it("records the guarantee beside the origin the entry actually had", async () => {
    const { events } = await run({
      subQueries: FALLBACK_SUB_QUERIES,
      store: makeFallbackStore(),
    });

    expect(events.find((event) => event.kind === "caller_priority")?.detail).toEqual({
      k: CALLER_PRIORITY_K,
      ids: ["p1", TARGET, "p2"],
      alreadyPresent: ["p1", TARGET, "p2"],
    });
    // The same typed event, and the caller's entry keeps its own origin: the
    // fallback route is recorded as the fallback route, never relabelled a rule.
    const searches = events.filter((event) => event.kind === "search_hits");
    expect(searches.map((event) => event.detail)).toMatchObject([
      { role: "factual", origin: "fallback", track: "primary" },
      { role: "factual", origin: "fallback", track: "fallback" },
    ]);
  });

  it("reaches the assembled context the generator reads", async () => {
    const { chunks } = await run({
      subQueries: FALLBACK_SUB_QUERIES,
      store: makeFallbackStore(),
    });
    const assembled = assemble(
      chunks,
      routedQuery(CALLER_TEXT, { subQueries: FALLBACK_SUB_QUERIES }),
    );

    expect(assembled.map((chunk) => chunk.id)).toEqual(["p1", TARGET, "p2", "p3"]);
    expect(assembled.findIndex((chunk) => chunk.id === TARGET)).toBe(1);
    expect(assembled.findIndex((chunk) => chunk.id === TARGET)).toBeLessThan(
      assembled.findIndex((chunk) => chunk.id === "p2"),
    );
  });

  it.each([
    ["the caller's text", `  ${CALLER_TEXT}\n`, CALLER_TEXT],
    ["the sub-query's text", CALLER_TEXT, `  ${CALLER_TEXT}\n`],
    ["both texts", ` ${CALLER_TEXT} `, `\n${CALLER_TEXT}  `],
  ])(
    "finds the entry by the admitted question with %s padded",
    async (_case, sourceText, subQueryText) => {
      const { chunks, events } = await run({
        subQueries: [{ text: subQueryText, role: "factual", origin: "fallback" }],
        store: makeFallbackStore(),
        sourceText,
      });
      // Padding is not a drop: both sides pass the same admission, so the padded
      // entry and the padded source text are the same question.
      expect(chunks[1]?.id).toBe(TARGET);
      expect(events.some((event) => event.kind === "caller_priority")).toBe(true);
    },
  );
});

describe("the guarantee reaches the assembled context the generator reads", () => {
  it("leads the presentation slot with the caller's rank-2 row, past fused score and rerank", async () => {
    // The decider's probabilities live on their own scale: two paraphrase rows
    // score far above the fused scores the guaranteed rows carry, the rest below.
    // Left to `rerankScore ?? score`, the caller's rank-2 row is compared across
    // those scales and lands behind the decider's top rows; the guarantee's tier
    // is what leads it instead.
    const { decider, specs } = answering([0.01, 0.2, 0.01, 0.01, 0.01, 0.2]);
    const { chunks } = await run({ decider });
    expect(specs).toHaveLength(1);
    const assembled = assemble(chunks);

    // The caller's own dense order leads the slot the whole fixture lives in.
    expect(assembled.slice(0, CALLER_PRIORITY_K).map((chunk) => chunk.id)).toEqual(CALLER_ROWS);
    expect(assembled.findIndex((chunk) => chunk.id === TARGET)).toBe(1);
    // ... and every paraphrase row, reranked or not, follows it.
    expect(assembled.findIndex((chunk) => PARAPHRASE_ROWS.includes(chunk.id))).toBe(
      CALLER_PRIORITY_K,
    );
    // No fabricated rerank score: the guarantee places rows it never offered.
    expect(
      assembled.slice(0, CALLER_PRIORITY_K).every((chunk) => chunk.rerankScore === undefined),
    ).toBe(true);
    // The rest of the slot is still the rerank's order.
    expect(assembled.slice(CALLER_PRIORITY_K).map((chunk) => chunk.id)).toEqual([
      "p2",
      "p6",
      "p1",
      "p3",
      "p4",
      "p5",
    ]);
  });
});

describe("the guarantee leads its own presentation slot, never the layout", () => {
  it("keeps a higher-ranked presentation slot ahead of the guaranteed rows", () => {
    const chunks: Chunk[] = [
      {
        id: "h1",
        text: "h1",
        score: 0.01,
        origin: CALLER_PRIORITY_ORIGIN,
        metadata: { sourceType: "hadith" },
      },
      { id: "q1", text: "q1", score: 0.9, metadata: { sourceType: "quran" } },
      { id: "h2", text: "h2", score: 0.9, metadata: { sourceType: "hadith" } },
    ];
    // The slot order is the spec's, not the guarantee's: the hadith slot leads with
    // the promoted row, but the Quran slot stays first.
    expect(assemble(chunks).map((chunk) => chunk.id)).toEqual(["q1", "h1", "h2"]);
  });
});

describe("the guarantee is bounded", () => {
  const hit = (id: string, rank: number): TrackHit => ({
    chunk: { id, text: `text-${id}`, rankDense: rank },
    rank,
  });

  it("takes at most k of the caller's leading hits, one row per chunk, ahead of the rest", () => {
    const callerLists = [
      ["a", "b", "c", "d", "e"].map((id, index) => hit(id, index + 1)),
      ["a", "b", "c", "d", "e"].map((id, index) => hit(id, index + 2)),
    ];
    const returned = ["e", "d", "c", "b", "a", "x"].map(
      (id) => ({ id, text: id, score: 0.1 }) as Chunk,
    );
    const result = guaranteeCallerPriority({ callerLists, returned, k: CALLER_PRIORITY_K });
    expect(result.detail?.ids).toHaveLength(CALLER_PRIORITY_K);
    // The better rank wins the duplicate: a is rank 1 on the first track, not 2.
    expect(result.detail?.ids).toEqual(["a", "b", "c"]);
    // The block leads in the caller's rank order; the rest keeps the set's order.
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["a", "b", "c", "e", "d", "x"]);
    expect(result.detail?.alreadyPresent).toEqual(["a", "b", "c"]);
    expect(new Set(result.chunks.map((chunk) => chunk.id)).size).toBe(result.chunks.length);
  });

  it("keeps a more specific arm's label and never duplicates a row", () => {
    const returned: Chunk[] = [
      { id: "x", text: "text-x" },
      { id: "b", text: "text-b", score: 0.2, origin: "scope_expansion" },
      { id: "y", text: "text-y" },
    ];
    const result = guaranteeCallerPriority({
      callerLists: [[hit("b", 2)]],
      returned,
      k: CALLER_PRIORITY_K,
    });
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["b", "x", "y"]);
    expect(result.chunks).toHaveLength(returned.length);
    expect(result.detail).toEqual({
      k: CALLER_PRIORITY_K,
      ids: ["b"],
      alreadyPresent: ["b"],
    });
    expect(result.chunks[0]?.origin).toBe("scope_expansion");
  });

  it("fabricates no chunk for a caller hit the set does not hold, and names it", () => {
    const result = guaranteeCallerPriority({
      callerLists: [[hit("b", 1)]],
      returned: [{ id: "x", text: "text-x" }],
      k: CALLER_PRIORITY_K,
    });
    // Fusion keeps every row a search returned; a miss here is an invariant
    // break the record exposes, not a chunk this rule invents without a score.
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["x"]);
    expect(result.detail).toEqual({ k: CALLER_PRIORITY_K, ids: ["b"], alreadyPresent: [] });
  });
});

describe("the guarantee applies the configured bound", () => {
  it("promotes exactly k rows and records the bound the run applied", async () => {
    const { chunks, events } = await run({ callerPriorityK: 1 });
    expect(
      chunks.filter((chunk) => chunk.origin === CALLER_PRIORITY_ORIGIN).map((chunk) => chunk.id),
    ).toEqual(["caller-1"]);
    // The promoted row leads the set: the bound decides how many rows carry the
    // label, not how many rows retrieval returned.
    expect(chunks[0]?.id).toBe("caller-1");
    expect(events.find((event) => event.kind === "caller_priority")?.detail).toEqual({
      k: 1,
      ids: ["caller-1"],
      alreadyPresent: ["caller-1"],
    });
  });

  it("disables the guarantee at zero without inventing a second shape", async () => {
    const { chunks, events } = await run({ callerPriorityK: 0 });
    expect(chunks.every((chunk) => chunk.origin === undefined)).toBe(true);
    expect(events.find((event) => event.kind === "caller_priority")?.detail).toEqual({
      k: 0,
      ids: [],
      alreadyPresent: [],
    });
  });
});

describe("a route without a caller list is unaffected", () => {
  it("guarantees nothing when no caller sub-query exists", () => {
    const returned: Chunk[] = [{ id: "x", text: "x" }];
    const result = guaranteeCallerPriority({ callerLists: [], returned, k: CALLER_PRIORITY_K });
    expect(result.chunks).toBe(returned);
    expect(result.detail).toBeNull();
  });

  it("leaves a route whose sub-queries are all paraphrases in its fused order", async () => {
    const { chunks, events } = await run({ subQueries: SUB_QUERIES.slice(1) });
    expect(chunks.map((chunk) => chunk.id)).toEqual(PARAPHRASE_ROWS);
    expect(chunks.every((chunk) => chunk.origin === undefined)).toBe(true);
    expect(events.some((event) => event.kind === "caller_priority")).toBe(false);
  });

  it("does not run at all for the content-free route gate", async () => {
    const { store, calls } = makeStore();
    let embeds = 0;
    const events: Recorded[] = [];
    const retriever = createChatRetriever({
      ...retrieverDeps(store, () => {
        embeds += 1;
      }),
      rerankDecider: null,
    });
    const chunks = await Effect.runPromise(
      Effect.provideService(
        retriever.retrieve(routedQuery("", { subQueries: [] as never }) as never),
        RunContext,
        {
          config: {},
          now: () => 1,
          record: (event: unknown) => events.push(event as Recorded),
        } as never,
      ) as never,
    );
    expect(chunks).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(embeds).toBe(0);
    expect(events.some((event) => event.kind === "caller_priority")).toBe(false);
  });
});

describe("the label keeps the guaranteed hits out of the rerank reorder", () => {
  it("holds the priority block in place while the fused block is reordered", async () => {
    // p6 wins, p2/p5 next: if the caller's rows were candidates they would move.
    const { decider, specs } = answering([0.1, 0.2, 0.1, 0.1, 0.2, 0.3]);
    const { chunks } = await run({ decider });

    expect(chunks.slice(0, 3).map((chunk) => chunk.id)).toEqual(CALLER_ROWS);
    // The rerank never saw them: a labelled chunk keeps its position.
    expect(chunks.slice(0, 3).every((chunk) => chunk.rerankScore === undefined)).toBe(true);
    const spec = specs[0] as { state: { candidates: string[] } };
    expect(spec.state.candidates).toEqual(PARAPHRASE_ROWS.map((id) => `arab-${id}`));
    // The fused block that was reranked moved: p6 leads it, not p1.
    expect(chunks.slice(3).map((chunk) => chunk.id)).toEqual(["p6", "p2", "p5", "p1", "p3", "p4"]);
    expect(chunks.slice(3).every((chunk) => typeof chunk.rerankScore === "number")).toBe(true);
  });
});

describe("a retrieval the guarantee covers entirely skips the rerank", () => {
  it("makes no decision call, and the trace says the guarantee caused the skip", async () => {
    const { decider, specs } = answering([0.5, 0.5]);
    // The caller's sub-query alone: its three rows are the whole fused set, so the
    // guarantee labels every candidate the rerank would have ranked.
    const { chunks, events } = await run({ subQueries: [CALLER_SUB_QUERY], decider });

    // No paid call: the decider was never asked.
    expect(specs).toHaveLength(0);
    expect(
      events.some(
        (event) =>
          event.kind === "llm_call" &&
          (event.detail as { purpose?: string } | undefined)?.purpose === "rerank",
      ),
    ).toBe(false);

    const rerank = events.find((event) => event.kind === "rerank")?.detail as
      | { outcome?: string; reason?: string; items?: unknown[] }
      | undefined;
    expect(rerank).toMatchObject({ outcome: "preserved", reason: "too_few_candidates" });

    // Attribution: retrieval returned a set large enough to rerank, and the whole
    // set is the guarantee's block — so the empty candidate list is the label's
    // doing, not a retrieval too small to offer two candidates.
    expect(chunks).toHaveLength(CALLER_PRIORITY_K);
    expect(chunks.every((chunk) => chunk.origin === CALLER_PRIORITY_ORIGIN)).toBe(true);
    expect(rerank?.items).toEqual([]);
    // The labelled rows keep the order retrieval gave them.
    expect(chunks.map((chunk) => chunk.id)).toEqual(CALLER_ROWS);
  });
});
