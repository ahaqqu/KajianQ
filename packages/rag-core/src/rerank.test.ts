import { Cause, Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { totalCostMicroUsd, type CostRecord, type TraceEvent } from "@app/contracts";
import type { ChoiceAnswer, DecisionAnswer, DecisionSpec, Decider } from "./decider";
import { RunContext } from "./context";
import { ProviderError } from "./provider";
import type { Chunk, DefaultFilters, Retriever, RoutedQuery } from "./pipeline";
import { createRerankedRetriever } from "./rerank";

/**
 * The rerank decorator's contract at the `Retriever` seam, exercised with an
 * injected `Decider` — the same seam #169's relevance screen uses, so a filter
 * composed outside this decorator sees the same fused list it would have
 * produced without it.
 */

const INSTRUCTIONS = "Which candidate passage best answers the question?";

const routed: RoutedQuery<DefaultFilters> = {
  sourceText: "the user's verbatim question",
  intent: "factual",
  subQueries: [{ text: "paraphrase" }],
  filters: {},
};

const chunks: readonly Chunk[] = [
  { id: "a", text: "alpha text", score: 0.9 },
  { id: "b", text: "bravo text", score: 0.5 },
  { id: "c", text: "charlie text", score: 0.1 },
];

const base: Retriever<DefaultFilters> = { retrieve: () => Effect.succeed(chunks) };

function cost(modelId: string, costMicroUsd: number): CostRecord {
  return { modelId, tokensIn: 10, tokensOut: 1, latencyMs: 20, costMicroUsd };
}

function choice(probabilities: readonly number[], pick: string): ChoiceAnswer {
  return {
    type: "choice",
    choice: pick,
    probabilities: Object.fromEntries(probabilities.map((p, i) => [`c${i}`, p])),
    confidence: 1,
  };
}

/** A decider that records every request and answers with the given answer. */
function answering(
  answer: DecisionAnswer,
  microUsd = 5,
): { decider: Decider; specs: DecisionSpec[] } {
  const specs: DecisionSpec[] = [];
  return {
    specs,
    decider: {
      modelId: "test-decider",
      decide: (spec) => {
        specs.push(spec);
        return Effect.succeed({ answers: { best: answer }, cost: cost("test-decider", microUsd) });
      },
    },
  };
}

function run(
  inner: Retriever<DefaultFilters>,
): Promise<{ chunks: readonly Chunk[]; events: TraceEvent[] }> {
  const events: TraceEvent[] = [];
  return Effect.runPromise(
    Effect.scoped(
      Effect.map(
        Effect.provideService(inner.retrieve(routed), RunContext, {
          config: {},
          now: () => 7,
          record: (event) => events.push(event),
        }),
        (result) => ({ chunks: result, events }),
      ),
    ),
  );
}

function reranker(
  decider: Decider,
  inner: Retriever<DefaultFilters> = base,
): Retriever<DefaultFilters> {
  return createRerankedRetriever(inner, { decider, instructions: INSTRUCTIONS });
}

function rerankEvent(events: readonly TraceEvent[]) {
  const event = events.find((e) => e.kind === "rerank");
  if (event?.kind !== "rerank") throw new Error("no rerank event");
  return event;
}

function llmCalls(events: readonly TraceEvent[]) {
  return events.filter((e) => e.kind === "llm_call");
}

describe("createRerankedRetriever — the ranking it applies", () => {
  it("orders the fused candidates by the decision model's probabilities, recording both scores", async () => {
    const { decider, specs } = answering(choice([0.1, 0.7, 0.2], "c1"));
    const { chunks: out, events } = await run(reranker(decider));

    expect(out.map((c) => c.id)).toEqual(["b", "c", "a"]);
    expect(out.map((c) => c.rerankScore)).toEqual([0.7, 0.2, 0.1]);
    // The fused score is never overwritten: the trace carries both.
    expect(out.map((c) => c.score)).toEqual([0.5, 0.1, 0.9]);

    const event = rerankEvent(events);
    expect(event.detail.outcome).toBe("applied");
    expect(event.detail.items).toEqual([
      { index: 0, key: "a", fusedScore: 0.9, rerankScore: 0.1, rankAfter: 2 },
      { index: 1, key: "b", fusedScore: 0.5, rerankScore: 0.7, rankAfter: 0 },
      { index: 2, key: "c", fusedScore: 0.1, rerankScore: 0.2, rankAfter: 1 },
    ]);
    // One request, built in the fused order the read maps back onto.
    expect(specs).toHaveLength(1);
    expect(llmCalls(events)).toHaveLength(1);
    expect(totalCostMicroUsd({ id: "t", createdAt: 1, events })).toBe(5);
  });

  it("sends the routed query's verbatim text and the fused texts as one Choice question", async () => {
    const { decider, specs } = answering(choice([0.2, 0.2, 0.6], "c2"));
    await run(reranker(decider));

    const spec = specs[0];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.personalData).toBe(true);
    expect(spec.state).toEqual({
      query: "the user's verbatim question",
      candidates: ["alpha text", "bravo text", "charlie text"],
    });
    expect(spec.questions).toEqual({
      best: {
        type: "choice",
        instructions: INSTRUCTIONS,
        criteria: { c0: null, c1: null, c2: null },
      },
    });
  });

  it("keeps the fused order when probabilities tie, comparing the index explicitly", async () => {
    const { decider } = answering(choice([0.5, 0.5, 0.5], "c0"));
    const { chunks: out } = await run(reranker(decider));
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(out.map((c) => c.rerankScore)).toEqual([0.5, 0.5, 0.5]);
  });

  it("keeps a caller-labelled chunk in its own position, filling only the fused slots", async () => {
    const input: readonly Chunk[] = [
      { id: "a", text: "alpha", score: 0.9 },
      { id: "scope", text: "added by a deterministic arm", origin: "scope_expansion" },
      { id: "b", text: "bravo", score: 0.5 },
      { id: "label", text: "added by the citation arm", origin: "citation_lookup" },
      { id: "c", text: "charlie", score: 0.1 },
    ];
    const { decider, specs } = answering(choice([0.1, 0.9, 0.5], "c1"));
    const { chunks: out } = await run(reranker(decider, { retrieve: () => Effect.succeed(input) }));

    expect(specs[0]?.state).toEqual({
      query: routed.sourceText,
      candidates: ["alpha", "bravo", "charlie"],
    });
    // The labelled chunks hold positions 1 and 3; the fused slots fill with the
    // reranked order (bravo, charlie, alpha).
    expect(out.map((c) => c.id)).toEqual(["b", "scope", "c", "label", "a"]);
    expect(out.map((c) => c.rerankScore)).toEqual([0.9, undefined, 0.5, undefined, 0.1]);
    expect(out[1]?.origin).toBe("scope_expansion");
    expect(out[3]?.origin).toBe("citation_lookup");
  });
});

describe("createRerankedRetriever — fail-open", () => {
  it("keeps the fused order on a typed vendor failure and keeps the attempt's cost", async () => {
    const decider: Decider = {
      modelId: "test-decider",
      decide: () =>
        Effect.fail(
          new ProviderError({
            kind: "server",
            message: "vendor down",
            attemptCosts: [cost("test-decider", 3)],
          }),
        ),
    };
    const { chunks: out, events } = await run(reranker(decider));

    expect(out).toEqual(chunks);
    expect(out.every((c) => c.rerankScore === undefined)).toBe(true);
    expect(rerankEvent(events).detail).toMatchObject({
      outcome: "preserved",
      reason: "vendor_failure",
    });
    // The failed attempt reached the vendor, so its spend is on the trace.
    expect(llmCalls(events).map((e) => e.cost?.costMicroUsd)).toEqual([3]);
    expect(totalCostMicroUsd({ id: "t", createdAt: 1, events })).toBe(3);
  });

  it("keeps the fused order when the decider throws instead of failing", async () => {
    const decider: Decider = {
      modelId: "test-decider",
      decide: () => {
        throw new Error("synchronous defect");
      },
    };
    const { chunks: out, events } = await run(reranker(decider));
    expect(out).toEqual(chunks);
    expect(rerankEvent(events).detail).toMatchObject({
      outcome: "preserved",
      reason: "thrown",
    });
  });

  it("keeps the fused order when the named choice is not the distribution's maximum", async () => {
    // c0 holds the mass but c1 is named: an answer that disagrees with itself.
    const { decider } = answering(choice([0.9, 0.1, 0], "c1"));
    const { chunks: out, events } = await run(reranker(decider));
    expect(out).toEqual(chunks);
    expect(rerankEvent(events).detail).toMatchObject({
      outcome: "preserved",
      reason: "choice_not_argmax",
    });
  });

  it("keeps the fused order when the distribution carries no mass at all", async () => {
    // No option holds probability: the named choice names no winner.
    const { decider } = answering(choice([0, 0, 0], "c0"));
    const { chunks: out, events } = await run(reranker(decider));
    expect(out).toEqual(chunks);
    expect(rerankEvent(events).detail).toMatchObject({
      outcome: "preserved",
      reason: "choice_not_argmax",
    });
  });

  it("keeps the fused order when the choice index is out of range", async () => {
    const { decider } = answering(choice([0.5, 0.5, 0], "c9"));
    const { chunks: out, events } = await run(reranker(decider));
    expect(out).toEqual(chunks);
    expect(rerankEvent(events).detail).toMatchObject({
      outcome: "preserved",
      reason: "out_of_range_choice",
    });
  });

  it("keeps the fused order when the choice is not one of the offered option keys", async () => {
    const { decider } = answering(choice([0.5, 0.5, 0], "best"));
    const { chunks: out, events } = await run(reranker(decider));
    expect(out).toEqual(chunks);
    expect(rerankEvent(events).detail).toMatchObject({
      outcome: "preserved",
      reason: "choice_outside_options",
    });
  });

  it("keeps the fused order when a candidate has no usable probability", async () => {
    const { decider } = answering({
      type: "choice",
      choice: "c0",
      probabilities: { c0: 0.9, c1: 0.1 },
      confidence: 1,
    });
    const { chunks: out, events } = await run(reranker(decider));
    expect(out).toEqual(chunks);
    expect(rerankEvent(events).detail).toMatchObject({
      outcome: "preserved",
      reason: "missing_probability",
    });
  });

  it("keeps the fused order when a probability is outside 0..1", async () => {
    const { decider } = answering(choice([1.5, -0.1, 0], "c0"));
    const { chunks: out, events } = await run(reranker(decider));
    expect(out).toEqual(chunks);
    expect(rerankEvent(events).detail).toMatchObject({
      outcome: "preserved",
      reason: "missing_probability",
    });
  });

  it("keeps the fused order when the answer is not a choice at all", async () => {
    const { decider } = answering({ type: "noul", noul: 0.9 });
    const { chunks: out, events } = await run(reranker(decider));
    expect(out).toEqual(chunks);
    expect(rerankEvent(events).detail).toMatchObject({
      outcome: "preserved",
      reason: "non_choice",
    });
  });

  it("makes no call when there is nothing to rank", async () => {
    const specs: DecisionSpec[] = [];
    const decider: Decider = {
      modelId: "test-decider",
      decide: (spec) => {
        specs.push(spec);
        return Effect.succeed({ answers: {}, cost: cost("test-decider", 1) });
      },
    };
    const none = await run(reranker(decider, { retrieve: () => Effect.succeed([]) }));
    expect(none.chunks).toEqual([]);
    expect(rerankEvent(none.events).detail).toMatchObject({
      outcome: "preserved",
      reason: "too_few_candidates",
      items: [],
    });

    const single = await run(
      reranker(decider, { retrieve: () => Effect.succeed([chunks[0] as Chunk]) }),
    );
    expect(single.chunks).toHaveLength(1);
    expect(rerankEvent(single.events).detail).toMatchObject({
      outcome: "preserved",
      reason: "too_few_candidates",
    });
    // The reason is one value for both cases; the recorded items say which.
    expect(rerankEvent(single.events).detail.items).toHaveLength(1);

    expect(specs).toEqual([]);
    expect(single.events.filter((e) => e.kind === "llm_call")).toEqual([]);
  });

  it("re-raises a cancellation instead of failing open, recording no verdict", async () => {
    const decider: Decider = {
      modelId: "test-decider",
      decide: () => Effect.interrupt,
    };
    const events: TraceEvent[] = [];
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.provideService(reranker(decider).retrieve(routed), RunContext, {
          config: {},
          now: () => 7,
          record: (event) => events.push(event),
        }),
      ),
    );

    // A cancelled run must stay cancelled: no preserved verdict, no chunk list.
    expect(exit._tag).toBe("Failure");
    expect(exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(events).toEqual([]);
  });
});
