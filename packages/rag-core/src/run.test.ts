import { describe, expect, it } from "vitest";
import { totalCostMicroUsd } from "@app/contracts";
import { runPipeline, type PipelineStages } from "./run";
import type {
  AssembledContext,
  Chunk,
  DefaultFilters,
  Draft,
  Query,
  RoutedQuery,
} from "./pipeline";
import type { RunConfig } from "./context";

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
      route: async () => routed("factual", ["sub1", "sub2"]),
    },
    retriever: {
      retrieve: async () => [
        { id: "c1", text: "evidence", score: 0.5, rankDense: 1, rankSparse: 2 },
      ],
    },
    assembler: {
      assemble: async (_q, chunks) => contextFor(chunks),
    },
    generator: {
      generate: async () => draft,
    },
    reviewer: {
      review: async (d) => d,
    },
    ...overrides,
  };
}

describe("runPipeline", () => {
  it("walks the five stages and emits deterministic events in order", async () => {
    const result = await runPipeline(makeStages(), query, config, {
      traceId: "t",
      now: () => 0,
    });
    expect(result.text).toBe("the answer");
    expect(result.trace.events.map((e) => e.kind)).toEqual([
      "intent",
      "subquery",
      "subquery",
      "retrieval",
      "assembly",
    ]);
  });

  it("threads the run config to every stage", async () => {
    const seen: RunConfig<DefaultFilters>[] = [];
    const stages = makeStages({
      router: {
        route: async (_q, run) => {
          seen.push(run.config);
          return routed("factual", []);
        },
      },
      retriever: {
        retrieve: async (_r, run) => {
          seen.push(run.config);
          return [];
        },
      },
      assembler: {
        assemble: async (_q, chunks, run) => {
          seen.push(run.config);
          return contextFor(chunks);
        },
      },
      generator: {
        generate: async (_ctx, run) => {
          seen.push(run.config);
          return draft;
        },
      },
      reviewer: {
        review: async (d, _ctx, run) => {
          seen.push(run.config);
          return d;
        },
      },
    });
    await runPipeline(stages, query, config, { traceId: "t", now: () => 0 });
    expect(seen).toHaveLength(5);
    for (const s of seen) expect(s).toBe(config);
  });

  it("records stage-emitted llm_call cost and refusal reason", async () => {
    const stages = makeStages({
      generator: {
        generate: async (_ctx, run) => {
          run.record({
            stage: "generator",
            kind: "llm_call",
            cost: { modelId: "m", tokensIn: 1, tokensOut: 2, latencyMs: 3, costMicroUsd: 40 },
            at: run.now(),
          });
          return draft;
        },
      },
      reviewer: {
        review: async (d, _ctx, run) => {
          run.record({
            stage: "reviewer",
            kind: "refusal",
            reason: "insufficient evidence",
            at: run.now(),
          });
          return d;
        },
      },
    });
    const result = await runPipeline(stages, query, {}, { traceId: "t", now: () => 1 });
    expect(totalCostMicroUsd(result.trace)).toBe(40);
    const refusal = result.trace.events.find((e) => e.kind === "refusal");
    expect(refusal).toMatchObject({ stage: "reviewer", reason: "insufficient evidence" });
  });

  it("runs deferred disposers in reverse registration order", async () => {
    const order: string[] = [];
    const stages = makeStages({
      retriever: {
        retrieve: async (_r, run) => {
          run.defer(() => {
            order.push("first");
          });
          run.defer(() => {
            order.push("second");
          });
          return [];
        },
      },
    });
    await runPipeline(stages, query, {}, { traceId: "t", now: () => 0 });
    expect(order).toEqual(["second", "first"]);
  });

  it("awaits async disposers and disposes even when a stage throws", async () => {
    const order: string[] = [];
    const stages = makeStages({
      generator: {
        generate: async (_ctx, run) => {
          run.defer(async () => {
            await Promise.resolve();
            order.push("cleanup");
          });
          throw new Error("boom");
        },
      },
    });
    await expect(
      runPipeline(stages, query, {}, { traceId: "t", now: () => 0 }),
    ).rejects.toThrow("boom");
    expect(order).toEqual(["cleanup"]);
  });

  it("omits undefined chunk ranks from the retrieval event", async () => {
    const stages = makeStages({
      retriever: {
        retrieve: async () => [{ id: "c0", text: "bare" }],
      },
    });
    const result = await runPipeline(stages, query, {}, { traceId: "t", now: () => 0 });
    const retrieval = result.trace.events.find((e) => e.kind === "retrieval");
    expect(retrieval).toMatchObject({ detail: { chunks: [{ id: "c0" }] } });
  });

  it("defaults the trace id and clock when options are omitted", async () => {
    const result = await runPipeline(makeStages(), query, config);
    expect(result.trace.id.length).toBeGreaterThan(0);
    expect(result.trace.events.length).toBeGreaterThan(0);
  });
});
