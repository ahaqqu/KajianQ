import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { CALLER_PRIORITY_K } from "@app/contracts";
import {
  RunContext,
  createRerankedRetriever,
  type ChoiceAnswer,
  type Chunk,
  type Decider,
} from "@app/rag-core";
import { createKajianQRetriever } from "./chat-retriever";
import {
  CALLER_PRIORITY_ORIGIN,
  guaranteeCallerPriority,
  type RetrieverStore,
  type TrackHit,
} from "./chat-retriever-parts";
import { routedQuery } from "./test-utils/routed-query";

/**
 * Caller-query priority (ADR-0062): the caller's own question is the one query
 * guaranteed to be in the user's vocabulary, so its leading dense hits are a
 * retrieval angle of their own. Fusion weighs every list alike and the router's
 * paraphrases outnumber the caller's single list, so this test makes the
 * paraphrase rows outscore the caller's rank-2 row on every list — and pins
 * that the row still enters the context under its own label, at the priority
 * position the rerank then leaves untouched.
 */

const cost = { modelId: "m", tokensIn: 1, tokensOut: 1, latencyMs: 1, costMicroUsd: 1 };

const TARGET = "ibnu-majah-224";
/** The caller's own dense list: the target sits at rank 2, on both tracks. */
const CALLER_ROWS = ["caller-1", TARGET, "caller-3"];
/** Rows only the paraphrases return — six lists' worth, so they outvote the caller. */
const PARAPHRASE_ROWS = ["p1", "p2", "p3", "p4", "p5", "p6"];

const CALLER_TEXT = "apa keutamaan menuntut ilmu";
const SUB_QUERIES = [
  { text: CALLER_TEXT, role: "factual", origin: "rule" },
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

type Recorded = { kind: string; detail?: unknown };

function makeRetriever(
  store: RetrieverStore,
  embed: (texts: readonly string[]) => void = () => {},
) {
  return createKajianQRetriever({
    store,
    embedder: {
      embed: ({ texts }) => {
        embed(texts);
        return Effect.succeed({
          vectors: texts.map((text) => (text === CALLER_TEXT ? [1, 0] : [0, 1])),
          cost,
        });
      },
    },
    bridge: ((e: unknown) => Effect.runPromise(e as never)) as never,
    limit: 10,
  });
}

function run(
  options: {
    subQueries?: { text: string; role?: string; origin?: string }[];
    decider?: Decider;
    record?: (event: Recorded) => void;
  } = {},
): Promise<{ chunks: readonly Chunk[]; events: Recorded[] }> {
  const { store } = makeStore();
  const events: Recorded[] = [];
  const inner = makeRetriever(store);
  const retriever =
    options.decider === undefined
      ? inner
      : createRerankedRetriever(inner, { decider: options.decider, instructions: "pick" });
  const routed = routedQuery(CALLER_TEXT, {
    subQueries: options.subQueries ?? SUB_QUERIES,
  });
  return Effect.runPromise(
    Effect.provideService(retriever.retrieve(routed as never), RunContext, {
      config: {},
      now: () => 7,
      record: (event: unknown) => events.push(event as Recorded),
    } as never) as never,
  ).then((chunks) => ({ chunks: chunks as readonly Chunk[], events }));
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

    // The paraphrase rows are in six lists at ranks 1–6, so fusion alone puts all
    // six ahead of the caller's rank-2 row; the guarantee is what leads the set.
    expect(chunks.slice(0, 3).map((chunk) => chunk.id)).toEqual(["caller-1", TARGET, "caller-3"]);
    const target = chunks.find((chunk) => chunk.id === TARGET);
    expect(target).toBeDefined();
    expect(target?.origin).toBe(CALLER_PRIORITY_ORIGIN);
    // Only the caller's leading hits are guaranteed; the rest keep the fused order.
    expect(chunks.filter((chunk) => chunk.origin === CALLER_PRIORITY_ORIGIN)).toHaveLength(
      CALLER_PRIORITY_K,
    );
    expect(
      chunks
        .slice(3)
        .map((chunk) => chunk.id)
        .sort(),
    ).toEqual([...PARAPHRASE_ROWS].sort());
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
  });

  it("records the bound, the guaranteed ids, and how much was already present", async () => {
    const { chunks, events } = await run();
    const event = events.find((entry) => entry.kind === "caller_priority");
    expect(event?.detail).toEqual({
      k: CALLER_PRIORITY_K,
      ids: ["caller-1", TARGET, "caller-3"],
      // Every search hit reaches fusion, so the guarantee promotes rather than adds.
      alreadyPresent: ["caller-1", TARGET, "caller-3"],
    });
    expect(JSON.stringify(event?.detail)).not.toContain("arab-");
    expect(chunks).toHaveLength(3 + PARAPHRASE_ROWS.length);
  });
});

describe("the guarantee is bounded", () => {
  const hit = (id: string, rank: number): TrackHit => ({
    chunk: { id, text: `text-${id}`, rankDense: rank },
    rank,
  });

  it("takes at most k hits, and one row both tracks returned is one hit", () => {
    const callerLists = [
      ["a", "b", "c", "d", "e"].map((id, index) => hit(id, index + 1)),
      ["a", "b", "c", "d", "e"].map((id, index) => hit(id, index + 2)),
    ];
    const result = guaranteeCallerPriority({
      callerLists,
      returned: ["x"].map((id) => ({ id, text: id }) as Chunk),
    });
    expect(result.detail?.ids).toHaveLength(CALLER_PRIORITY_K);
    // The better rank wins the duplicate: a is rank 1 on the first track, not 2.
    expect(result.detail?.ids).toEqual(["a", "b", "c"]);
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["a", "b", "c", "x"]);
    expect(result.detail?.alreadyPresent).toEqual([]);
    expect(new Set(result.chunks.map((chunk) => chunk.id)).size).toBe(result.chunks.length);
  });

  it("never duplicates a row the returned set already holds", () => {
    const returned: Chunk[] = [
      { id: "x", text: "text-x" },
      { id: "b", text: "text-b", score: 0.2 },
      { id: "y", text: "text-y" },
    ];
    const result = guaranteeCallerPriority({
      callerLists: [[hit("b", 2)]],
      returned,
    });
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["b", "x", "y"]);
    expect(result.chunks).toHaveLength(returned.length);
    expect(result.detail).toEqual({ k: CALLER_PRIORITY_K, ids: ["b"], alreadyPresent: ["b"] });
    // The existing chunk's own label wins over the guarantee's.
    const labelled = guaranteeCallerPriority({
      callerLists: [[hit("b", 2)]],
      returned: [{ id: "b", text: "text-b", origin: "scope_expansion" }],
    });
    expect(labelled.chunks[0]?.origin).toBe("scope_expansion");
  });
});

describe("a route without a caller list is unaffected", () => {
  it("guarantees nothing when no caller sub-query exists", () => {
    const returned: Chunk[] = [{ id: "x", text: "x" }];
    const result = guaranteeCallerPriority({ callerLists: [], returned });
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
    const retriever = makeRetriever(store, () => {
      embeds += 1;
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

    expect(chunks.slice(0, 3).map((chunk) => chunk.id)).toEqual(["caller-1", TARGET, "caller-3"]);
    // The rerank never saw them: a labelled chunk keeps its position.
    expect(chunks.slice(0, 3).every((chunk) => chunk.rerankScore === undefined)).toBe(true);
    const spec = specs[0] as { state: { candidates: string[] } };
    expect(spec.state.candidates).toEqual(PARAPHRASE_ROWS.map((id) => `arab-${id}`));
    // The fused block that was reranked moved: p6 leads it, not p1.
    expect(chunks.slice(3).map((chunk) => chunk.id)).toEqual(["p6", "p2", "p5", "p1", "p3", "p4"]);
    expect(chunks.slice(3).every((chunk) => typeof chunk.rerankScore === "number")).toBe(true);
  });
});
