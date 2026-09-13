import { Effect, Exit, Fiber, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { streamHandle } from "./chat-stream";
import { failureOf, runFail } from "@app/rag-core/testing";
import type { ProviderError, StreamHandle } from "@app/rag-core";

/** An SSE body that emits the given chunks then closes. */
function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** An SSE body that stalls after one chunk — the next read() pends forever. */
function stalledSseBody(firstChunk: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(firstChunk));
      // Never closes — a consumer awaiting the next delta hangs until the
      // stream is interrupted.
    },
  });
}

/** Drain a StreamHandle's deltas and resolve its deferred cost. */
async function collect(handle: StreamHandle): Promise<string> {
  const chunks = await Effect.runPromise(Stream.runCollect(handle.deltas));
  return Array.from(chunks).join("");
}

function makeHandle(body: ReadableStream<Uint8Array>, aborts: string[] = []): StreamHandle {
  return streamHandle({
    body,
    abort: () => aborts.push("abort"),
    modelId: "m",
    price: { in: 500, out: 3000 },
    promptTokensInEstimate: 2,
    startedAt: Date.now(),
  });
}

describe("streamHandle", () => {
  it("cost() resolves without consuming deltas (no deadlock)", async () => {
    const handle = makeHandle(
      sseBody([
        'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
      ]),
    );
    const cost = await Effect.runPromise(handle.cost()); // must not hang
    expect(cost.tokensIn).toBe(7);
  });

  it("cost() resolves after deltas are fully consumed", async () => {
    const handle = makeHandle(
      sseBody(['data: {"choices":[{"delta":{"content":"abc"}}]}\n\n', "data: [DONE]\n\n"]),
    );
    const text = await collect(handle);
    expect(text).toBe("abc");
    const cost = await Effect.runPromise(handle.cost());
    expect(cost.estimated).toBe(true); // no usage chunk → estimated
  });

  it("metered usage beats the char estimates", async () => {
    const handle = makeHandle(
      sseBody([
        'data: {"choices":[{"delta":{"content":"ab"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":5,"completion_tokens":9}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const cost = await Effect.runPromise(handle.cost());
    expect(cost.tokensIn).toBe(5); // metered, not the estimate (2)
    expect(cost.tokensOut).toBe(9); // metered, not the char estimate (1)
    expect(cost.estimated).toBe(false);
  });

  it("a stream failing mid-flight fails the deltas stream and the cost effect", async () => {
    // The wire delivers one delta, then cuts: the attempt reached the vendor
    // and produced partial output before failing.
    let reads = 0;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
        } else {
          throw new Error("wire cut");
        }
      },
    });
    const handle = makeHandle(body);
    const deltasExit = await Effect.runPromiseExit(Stream.runCollect(handle.deltas));
    expect(deltasExit._tag).toBe("Failure");
    // The wire cut fails cost with a typed transport ProviderError (shared
    // runFail: fails the test unless cost() exits with a typed failure).
    const costError = await runFail(handle.cost());
    expect(costError.kind).toBe("transport");
    // C2: the attempt reached the vendor (a delta flowed before the wire
    // cut), so the failure carries the attempt's estimated cost — prompt
    // estimate plus the partial output — for the trace sink. The spend may
    // not vanish from the cost trail.
    expect(costError.attemptCosts).toBeDefined();
    expect(costError.attemptCosts).toHaveLength(1);
    expect(costError.attemptCosts![0]!.tokensIn).toBe(2); // promptTokensInEstimate
    expect(costError.attemptCosts![0]!.tokensOut).toBe(1); // ceil(3 chars/4)
    expect(costError.attemptCosts![0]!.estimated).toBe(true);
  });

  it("interrupting the deltas stream aborts the provider fetch", async () => {
    const aborts: string[] = [];
    const handle = makeHandle(
      stalledSseBody('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'),
      aborts,
    );
    // Consume via a child fiber under a live root; interrupt it while the
    // next read() pends. (forkScoped under a kept-alive scope: an
    // Effect.fork root would die the moment runPromise returns, killing the
    // whole tree before the interruption is observed.)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(Stream.runDrain(handle.deltas));
          yield* Effect.sleep(50); // first delta consumed, next read pends
          yield* Fiber.interrupt(fiber);
        }),
      ),
    );
    expect(aborts).toEqual(["abort"]); // the wire was cut
  });

  it("cost() after an interrupted stream fails deterministically instead of hanging", async () => {
    const aborts: string[] = [];
    const handle = makeHandle(
      stalledSseBody('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'),
      aborts,
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(Stream.runDrain(handle.deltas));
          yield* Effect.sleep(50);
          yield* Fiber.interrupt(fiber);
        }),
      ),
    );
    // cost() must settle (fail) even though the underlying read never
    // completes — bounded by a timeout so a regression hangs, not passes.
    // A fired timeout surfaces as a Failure whose error is a
    // TimeoutException (no `kind`), so the transport kind below proves the
    // settlement came from the interruption path, not the timeout.
    const exit = await Effect.runPromiseExit(handle.cost().pipe(Effect.timeout("1 second")));
    expect(exit._tag).toBe("Failure");
    expect(Option.getOrThrow(failureOf(exit as Exit.Exit<unknown, ProviderError>)).kind).toBe(
      "transport",
    );
  });

  it("an unconsumed stream that is cost-drained is never aborted", async () => {
    const aborts: string[] = [];
    const handle = makeHandle(
      sseBody(['data: {"choices":[{"delta":{"content":"abc"}}]}\n\n', "data: [DONE]\n\n"]),
      aborts,
    );
    const cost = await Effect.runPromise(handle.cost());
    expect(cost.tokensOut).toBe(1); // ceil(3 chars/4)
    expect(cost.tokensIn).toBe(2); // promptTokensInEstimate
    expect(cost.estimated).toBe(true);
    expect(aborts).toEqual([]); // drain completed naturally — no abort
  });
});
