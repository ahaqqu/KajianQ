import { Cause, Effect, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type { CostRecord } from "@app/contracts";
import { RunContext } from "./context";
import { StageError } from "./errors";
import { engineStreamToWeb, runPipelinePromise } from "./interop";
import type { Chunk, Draft } from "./pipeline";
import type { PipelineStages } from "./run";
import { ProviderError, type StreamHandle } from "./provider";

const stages: PipelineStages = {
  router: { route: () => Effect.succeed({ intent: "factual", subQueries: [], filters: {} }) },
  retriever: { retrieve: () => Effect.succeed<readonly Chunk[]>([]) },
  assembler: {
    assemble: (_q, chunks) =>
      Effect.succeed({ query: { intent: "factual", subQueries: [], filters: {} }, chunks, turns: [] }),
  },
  generator: { generate: () => Effect.succeed<Draft>({ text: "the answer" }) },
  reviewer: { review: (d) => Effect.succeed(d) },
};

const cost: CostRecord = {
  modelId: "m",
  tokensIn: 1,
  tokensOut: 1,
  latencyMs: 1,
  costMicroUsd: 1,
};

describe("runPipelinePromise (HTTP-edge bridge)", () => {
  it("resolves with the answer and a parseable trace", async () => {
    const answer = await runPipelinePromise(stages, { text: "q" }, {}, { traceId: "t", now: () => 0 });
    expect(answer.text).toBe("the answer");
    expect(answer.trace.id).toBe("t");
  });

  it("rejects with the typed StageError when a stage fails", async () => {
    const failing: PipelineStages = {
      ...stages,
      generator: {
        generate: () =>
          Effect.gen(function* () {
            const run = yield* RunContext;
            run.record({
              stage: "generator",
              kind: "refusal",
              reason: "insufficient evidence",
              at: run.now(),
            });
            return yield* Effect.fail(
              new StageError({ stage: "generator", cause: new Error("boom") }),
            );
          }),
      },
    };
    const err = await runPipelinePromise(failing, { text: "q" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageError);
    expect((err as StageError).stage).toBe("generator");
  });
});

describe("engineStreamToWeb", () => {
  it("bridges a provider delta stream into a web ReadableStream", async () => {
    const handle: StreamHandle = {
      deltas: Stream.make("he", "llo"),
      cost: () => Effect.succeed(cost),
    };
    const web = engineStreamToWeb(handle.deltas);
    const text = await new Response(web).text();
    expect(text).toBe("hello");
  });

  it("errors the web stream when the provider stream fails", async () => {
    const handle: StreamHandle = {
      deltas: Stream.fail(new ProviderError({ kind: "transport", message: "cut" })),
      cost: () => Effect.fail(new ProviderError({ kind: "transport", message: "cut" })),
    };
    const res = new Response(engineStreamToWeb(handle.deltas));
    await expect(res.text()).rejects.toThrow();
  });
});
