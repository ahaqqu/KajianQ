import { Cause, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { totalCostMicroUsd } from "@app/contracts";
import { RunContext } from "./context";
import type { RunConfig } from "./context";
import { StageError } from "./errors";
import { runPipeline, type PipelineStages } from "./run";
import type {
  AssembledContext,
  Chunk,
  DefaultFilters,
  Draft,
  Query,
  RoutedQuery,
} from "./pipeline";

const query: Query<DefaultFilters> = { text: "a question" };
const config: RunConfig<DefaultFilters> = {
  models: { generator: "m-generator", router: "m-router" },
  filters: { scope: "all" },
};

function routed(intent: string, subQueries: readonly string[]): RoutedQuery<DefaultFilters> {
  return {
    intent,
    subQueries: subQueries.map((text) => ({ text })),
    filters: { scope: "all" },
  };
}

function contextFor(chunks: readonly Chunk[]): AssembledContext<DefaultFilters> {
  return {
    query: routed("factual", ["sub"]),
    chunks,
    turns: [{ role: "system", content: "prelude" }],
  };
}

const draft: Draft = { text: "the answer" };

function makeStages(
  overrides: Partial<PipelineStages<DefaultFilters>> = {},
): PipelineStages<DefaultFilters> {
  return {
    router: {
      route: () => Effect.succeed(routed("factual", ["sub1", "sub2"])),
    },
    retriever: {
      retrieve: () =>
        Effect.succeed([
          { id: "c1", text: "evidence", score: 0.5, rankDense: 1, rankSparse: 2 },
        ]),
    },
    assembler: {
      assemble: (_q, chunks) => Effect.succeed(contextFor(chunks)),
    },
    generator: {
      generate: () => Effect.succeed(draft),
    },
    reviewer: {
      review: (d) => Effect.succeed(d),
    },
    ...overrides,
  };
}

describe("runPipeline", () => {
  it("walks the five stages and emits deterministic events in order", async () => {
    const result = await Effect.runPromise(
      runPipeline(makeStages(), query, config, { traceId: "t", now: () => 0 }),
    );
    expect(result.text).toBe("the answer");
    expect(result.trace.events.map((e) => e.kind)).toEqual([
      "intent",
      "subquery",
      "subquery",
      "retrieval",
      "assembly",
    ]);
  });

  it("provides the run config to every stage through the RunContext service", async () => {
    const seen: RunConfig<Record<string, unknown>>[] = [];
    const stageWithConfig = () =>
      Effect.gen(function* () {
        const run = yield* RunContext;
        seen.push(run.config);
      });
    const stages = makeStages({
      router: {
        route: () =>
          Effect.gen(function* () {
            yield* stageWithConfig();
            return routed("factual", []);
          }),
      },
      retriever: {
        retrieve: () =>
          Effect.gen(function* () {
            yield* stageWithConfig();
            return [];
          }),
      },
      assembler: {
        assemble: (_q, chunks) =>
          Effect.gen(function* () {
            yield* stageWithConfig();
            return contextFor(chunks);
          }),
      },
      generator: {
        generate: () =>
          Effect.gen(function* () {
            yield* stageWithConfig();
            return draft;
          }),
      },
      reviewer: {
        review: (d) =>
          Effect.gen(function* () {
            yield* stageWithConfig();
            return d;
          }),
      },
    });
    await Effect.runPromise(runPipeline(stages, query, config, { traceId: "t", now: () => 0 }));
    expect(seen).toHaveLength(5);
    for (const s of seen) expect(s).toBe(config);
  });

  it("records stage-emitted llm_call cost and refusal reason", async () => {
    const stages = makeStages({
      generator: {
        generate: () =>
          Effect.gen(function* () {
            const run = yield* RunContext;
            run.record({
              stage: "generator",
              kind: "llm_call",
              cost: { modelId: "m", tokensIn: 1, tokensOut: 2, latencyMs: 3, costMicroUsd: 40 },
              at: run.now(),
            });
            return draft;
          }),
      },
      reviewer: {
        review: (d) =>
          Effect.gen(function* () {
            const run = yield* RunContext;
            run.record({
              stage: "reviewer",
              kind: "refusal",
              reason: "insufficient evidence",
              at: run.now(),
            });
            return d;
          }),
      },
    });
    const result = await Effect.runPromise(
      runPipeline(stages, query, {}, { traceId: "t", now: () => 1 }),
    );
    expect(totalCostMicroUsd(result.trace)).toBe(40);
    const refusal = result.trace.events.find((e) => e.kind === "refusal");
    expect(refusal).toMatchObject({ stage: "reviewer", reason: "insufficient evidence" });
  });

  it("runs per-run finalizers in reverse registration order", async () => {
    const order: string[] = [];
    const stages = makeStages({
      retriever: {
        retrieve: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => order.push("first")));
            yield* Effect.addFinalizer(() => Effect.sync(() => order.push("second")));
            return [];
          }),
      },
    });
    await Effect.runPromise(runPipeline(stages, query, {}, { traceId: "t", now: () => 0 }));
    expect(order).toEqual(["second", "first"]);
  });

  it("awaits async finalizers and disposes even when a stage fails", async () => {
    const order: string[] = [];
    const stages = makeStages({
      generator: {
        generate: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                await Promise.resolve();
                order.push("cleanup");
              }),
            );
            return yield* Effect.fail(
              new StageError({ stage: "generator", cause: new Error("boom") }),
            );
          }),
      },
    });
    const exit = await Effect.runPromiseExit(runPipeline(stages, query, {}, { traceId: "t", now: () => 0 }));
    expect(order).toEqual(["cleanup"]);
    const failure = exit._tag === "Failure" ? Cause.failureOption(exit.cause) : undefined;
    expect(failure).toBeDefined();
    if (failure && failure._tag === "Some") {
      const err = failure.value;
      expect(err).toBeInstanceOf(StageError);
      expect(err.stage).toBe("generator");
      expect((err.cause as Error).message).toBe("boom");
    }
  });

  it("omits undefined chunk ranks from the retrieval event", async () => {
    const stages = makeStages({
      retriever: {
        retrieve: () => Effect.succeed([{ id: "c0", text: "bare" }]),
      },
    });
    const result = await Effect.runPromise(
      runPipeline(stages, query, {}, { traceId: "t", now: () => 0 }),
    );
    const retrieval = result.trace.events.find((e) => e.kind === "retrieval");
    expect(retrieval).toMatchObject({ detail: { chunks: [{ id: "c0" }] } });
  });

  it("defaults the trace id and clock when options are omitted", async () => {
    const result = await Effect.runPromise(runPipeline(makeStages(), query, config));
    expect(result.trace.id.length).toBeGreaterThan(0);
    expect(result.trace.events.length).toBeGreaterThan(0);
  });
});
