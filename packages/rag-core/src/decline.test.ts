import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { totalCostMicroUsd, type CostRecord } from "@app/contracts";
import { RunContext } from "./context";
import type { PipelineStages } from "./run";
import { runPipeline } from "./run";

/**
 * The runner's decline seam: the run's one early exit, and the invariant it
 * owns — **a run that declines never enters the two stages that can spend, and
 * the trace says so.**
 *
 * The fixture's generator is deliberately not free: it records an `llm_call`
 * with a cost through the run's own sink. "Zero cost on the declined path" would
 * prove nothing against a generator that happened to be free; against this one
 * it proves the stage was never entered.
 */

const COST: CostRecord = {
  modelId: "stub-generator",
  tokensIn: 11,
  tokensOut: 7,
  latencyMs: 3,
  costMicroUsd: 7,
};

const VERDICT = {
  text: "Canned product copy.",
  reason: "the route carries nothing to generate for",
  trigger: "stub_decline",
};

type Calls = {
  router: number;
  retriever: number;
  assembler: number;
  generator: number;
  reviewer: number;
  decliner: number;
};

/** The five stages plus an optional decliner, every one of them a spy. */
function harness(options: { decline?: boolean; withDecliner?: boolean } = {}): {
  stages: PipelineStages;
  calls: Calls;
} {
  const calls: Calls = {
    router: 0,
    retriever: 0,
    assembler: 0,
    generator: 0,
    reviewer: 0,
    decliner: 0,
  };
  const stages: PipelineStages = {
    router: {
      route: () =>
        Effect.sync(() => {
          calls.router += 1;
          return { intent: "factual", subQueries: [], filters: {} };
        }),
    },
    retriever: {
      retrieve: () =>
        Effect.sync(() => {
          calls.retriever += 1;
          return [];
        }),
    },
    assembler: {
      assemble: (routed, chunks) =>
        Effect.sync(() => {
          calls.assembler += 1;
          return { query: routed, chunks, turns: [{ role: "user", content: routed.sourceText }] };
        }),
    },
    generator: {
      generate: () =>
        Effect.gen(function* () {
          calls.generator += 1;
          const run = yield* RunContext;
          run.record({
            stage: "generator",
            kind: "llm_call",
            detail: { purpose: "generate" },
            cost: COST,
            at: run.now(),
          });
          return { text: "A generated answer." };
        }),
    },
    reviewer: {
      review: (draft) =>
        Effect.sync(() => {
          calls.reviewer += 1;
          return draft;
        }),
    },
  };
  if (options.withDecliner !== false) {
    stages.decliner = {
      decline: () =>
        Effect.sync(() => {
          calls.decliner += 1;
          return options.decline === true ? VERDICT : null;
        }),
    };
  }
  return { stages, calls };
}

function run(stages: PipelineStages, text = "a question") {
  return Effect.runPromise(runPipeline(stages, { text }));
}

const kindsOf = (answer: { trace: { events: { kind: string }[] } }) =>
  answer.trace.events.map((event) => event.kind);

describe("the runner's decline seam", () => {
  it("answers from the verdict and never enters the generator or the reviewer", async () => {
    const { stages, calls } = harness({ decline: true });

    const answer = await run(stages);

    expect(answer.text).toBe(VERDICT.text);
    // The route, the empty fan-out and the assembly still happened: the decline
    // replaces the answer, not the run's account of how it got there.
    expect(calls).toMatchObject({ router: 1, retriever: 1, assembler: 1, decliner: 1 });
    expect(calls.generator).toBe(0);
    expect(calls.reviewer).toBe(0);
    // No provider call at all, and therefore nothing to price.
    expect(kindsOf(answer)).not.toContain("llm_call");
    expect(totalCostMicroUsd(answer.trace)).toBe(0);
    expect(kindsOf(answer)).toEqual(["intent", "retrieval", "assembly", "refusal"]);
  });

  it("records the decline on the trace from the verdict's own account", async () => {
    const { stages } = harness({ decline: true });

    const answer = await run(stages);

    const refusals = answer.trace.events.filter((event) => event.kind === "refusal");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      stage: "generator",
      detail: { trigger: VERDICT.trigger },
      reason: VERDICT.reason,
    });
    expect(refusals[0]?.cost).toBeUndefined();
  });

  it("runs the five stages unchanged when the seam declines nothing", async () => {
    const { stages, calls } = harness({ decline: false });

    const answer = await run(stages);

    expect(calls).toMatchObject({ router: 1, retriever: 1, assembler: 1, decliner: 1 });
    expect(calls.generator).toBe(1);
    expect(calls.reviewer).toBe(1);
    expect(answer.text).toBe("A generated answer.");
    expect(kindsOf(answer)).not.toContain("refusal");
    expect(totalCostMicroUsd(answer.trace)).toBe(COST.costMicroUsd);
  });

  it("leaves a run with no decline seam wired exactly as it was", async () => {
    const { stages, calls } = harness({ withDecliner: false });

    const answer = await run(stages);

    expect(calls.decliner).toBe(0);
    expect(calls.generator).toBe(1);
    expect(calls.reviewer).toBe(1);
    expect(kindsOf(answer)).toEqual(["intent", "retrieval", "assembly", "llm_call"]);
  });
});
