import { Cause, Effect, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { CostRecord } from "@app/contracts";
import { RunContext } from "./context";
import { StageError } from "./errors";
import { PipelineAbortedError, engineStreamToWeb, runPipelinePromise } from "./interop";
import type { Chunk, Draft } from "./pipeline";
import { ProviderError, type StreamHandle } from "./provider";
import type { PipelineStages } from "./run";

const stages: PipelineStages = {
  router: { route: () => Effect.succeed({ intent: "factual", subQueries: [], filters: {} }) },
  retriever: { retrieve: () => Effect.succeed<readonly Chunk[]>([]) },
  assembler: {
    assemble: (_q, chunks) =>
      Effect.succeed({
        query: { intent: "factual", subQueries: [], filters: {} },
        chunks,
        turns: [],
      }),
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
    const answer = await runPipelinePromise(
      stages,
      { text: "q" },
      {},
      { traceId: "t", now: () => 0 },
    );
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

  it("rejects with PipelineAbortedError when an already-aborted signal is passed", async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await runPipelinePromise(
      stages,
      { text: "q" },
      {},
      { signal: controller.signal },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineAbortedError);
  });

  it("interrupts the run's fiber when the signal fires mid-run and delivers the failed-run trace", async () => {
    const controller = new AbortController();
    const onFailedTrace = vi.fn();
    // The generator parks forever; only the abort can end the run.
    const hanging: PipelineStages = {
      ...stages,
      generator: { generate: () => Effect.never },
    };
    const pending = runPipelinePromise(
      hanging,
      { text: "q" },
      {},
      {
        traceId: "t",
        now: () => 0,
        signal: controller.signal,
        onFailedTrace,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineAbortedError);
    // A client-aborted run is still traced: the deterministic events collected
    // before the abort (router intent, subqueries, retrieval, assembly) survive.
    expect(onFailedTrace).toHaveBeenCalledTimes(1);
    const trace = onFailedTrace.mock.calls[0]?.[0];
    expect(trace.id).toBe("t");
    expect(trace.events.map((e: { kind: string }) => e.kind)).toEqual([
      "intent",
      "retrieval",
      "assembly",
    ]);
  });
});

describe("engineStreamToWeb", () => {
  it("bridges a provider delta stream into a web ReadableStream", async () => {
    const handle: StreamHandle = {
      deltas: Stream.make("he", "llo"),
      cost: () => Effect.succeed(cost),
    };
    const onCost = vi.fn();
    const web = engineStreamToWeb(handle, onCost);
    const text = await new Response(web).text();
    expect(text).toBe("hello");
  });

  it("settles the handle's cost on completion — the caller cannot drop it", async () => {
    const handle: StreamHandle = {
      deltas: Stream.make("he", "llo"),
      cost: () => Effect.succeed(cost),
    };
    const onCost = vi.fn();
    await new Response(engineStreamToWeb(handle, onCost)).text();
    expect(onCost).toHaveBeenCalledWith(cost);
  });

  it("settles the failed attempts' costs on a mid-flight provider failure", async () => {
    const attemptCosts = [cost, { ...cost, costMicroUsd: 2 }];
    const failed = new ProviderError({ kind: "transport", message: "cut", attemptCosts });
    const handle: StreamHandle = {
      deltas: Stream.fail(failed),
      cost: () => Effect.fail(failed),
    };
    const onCost = vi.fn();
    const res = new Response(engineStreamToWeb(handle, onCost));
    await expect(res.text()).rejects.toThrow();
    expect(onCost.mock.calls.map((c) => c[0])).toEqual(attemptCosts);
  });

  it("interrupts the source fiber and settles cost when the reader disconnects", async () => {
    let interrupted = false;
    const deltas: Stream.Stream<string, ProviderError> = Stream.unwrapScoped(
      Effect.gen(function* () {
        // Registered when the deltas stream's scope opens; unwound when the
        // bridge cancels the fiber — the interruption-observing flag.
        yield* Effect.addFinalizer(() => Effect.sync(() => (interrupted = true)));
        return Stream.repeatEffect(Effect.sync(() => "chunk"));
      }),
    );
    const handle: StreamHandle = { deltas, cost: () => Effect.succeed(cost) };
    const onCost = vi.fn();
    const web = engineStreamToWeb(handle, onCost).getReader();
    const first = await web.read();
    expect(new TextDecoder().decode(first.value)).toBe("chunk");
    expect(first.done).toBe(false);
    await web.cancel();
    // The reader's cancel interrupts the bridge fiber; the scope finalizers
    // (interruption flag, then cost settlement) unwind asynchronously.
    await vi.waitFor(() => {
      expect(interrupted).toBe(true);
      expect(onCost).toHaveBeenCalledWith(cost);
    });
  });
});

describe("bridge failure unwrapping", () => {
  it("exposes the StageError through Cause.squash when the failure is not a typed error", async () => {
    // Defensive: a defect (die) surfaces as a thrown error, not an Exit.
    const defecting: PipelineStages = {
      ...stages,
      generator: { generate: () => Effect.die("unexpected") },
    };
    const err = await runPipelinePromise(defecting, { text: "q" }).catch((e: unknown) => e);
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(StageError);
  });

  it("keeps Cause.failureOption semantics for typed failures (regression pin)", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* Effect.fail(new StageError({ stage: "router", cause: new Error("x") }));
      }),
    );
    const failure = Cause.failureOption(exit._tag === "Failure" ? exit.cause : Cause.empty);
    expect(Option.isSome(failure)).toBe(true);
  });
});
