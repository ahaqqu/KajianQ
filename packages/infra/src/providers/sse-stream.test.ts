import { Cause, Effect, Fiber, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type { CostRecord } from "@app/contracts";
import type { ProviderError } from "@app/rag-core";
import { readSseStream, streamSse, type StreamUsage } from "./sse-stream";

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const delta of iterable) out.push(delta);
  return out;
}

describe("readSseStream", () => {
  it("yields deltas from newline-delimited data lines", async () => {
    const it = readSseStream(
      sseBody(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n', "data: [DONE]\n\n"]),
    );
    const deltas = await collect(it);
    expect(deltas).toEqual(["a"]);
  });

  it("handles CRLF line endings", async () => {
    const it = readSseStream(
      sseBody(['data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\n', "data: [DONE]\r\n\r\n"]),
    );
    const deltas = await collect(it);
    expect(deltas).toEqual(["a"]);
  });

  it("parses JSON spanning chunk boundaries", async () => {
    const it = readSseStream(
      sseBody([
        'data: {"choices":[{"delta":{"con',
        'tent":"split"}}]}\n\n',
      ]),
    );
    const deltas = await collect(it);
    expect(deltas).toEqual(["split"]);
  });

  it("processes the final line even without a trailing newline", async () => {
    // A vendor that ends the body right after the usage chunk — the usage
    // must not be silently dropped.
    const it = readSseStream(
      sseBody([
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}',
      ]),
    );
    let result = await it.next();
    while (!result.done) result = await it.next();
    expect(result.value.usage?.prompt_tokens).toBe(5);
    // The delta before the trailing usage chunk was still surfaced.
  });

  it("skips malformed JSON lines without failing", async () => {
    const it = readSseStream(
      sseBody(["data: not-json\n\n", 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']),
    );
    const deltas = await collect(it);
    expect(deltas).toEqual(["ok"]);
  });
});

describe("streamSse", () => {
  const buildCost = (usage: StreamUsage | undefined, charCount: number): CostRecord => ({
    modelId: "m",
    tokensIn: usage?.prompt_tokens ?? 0,
    tokensOut: charCount,
    latencyMs: 1,
    costMicroUsd: 1,
    estimated: usage === undefined,
  });

  it("cost resolves without consuming deltas (eager pump, no deadlock)", async () => {
    const handle = streamSse(
      sseBody([
        'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
      ]),
      buildCost,
      () => {},
    );
    const cost = await Effect.runPromise(handle.cost()); // must not hang
    expect(cost.tokensIn).toBe(7);
  });

  it("cost resolves after deltas are fully consumed", async () => {
    const handle = streamSse(
      sseBody(['data: {"choices":[{"delta":{"content":"abc"}}]}\n\n', "data: [DONE]\n\n"]),
      buildCost,
      () => {},
    );
    const text = await Effect.runPromise(Stream.runCollect(handle.deltas).pipe(
      Effect.map((c) => Array.from(c).join("")),
    ));
    expect(text).toBe("abc");
    const cost = await Effect.runPromise(handle.cost());
    expect(cost.estimated).toBe(true); // no usage chunk
  });

  it("interrupting the delta stream cancels the underlying fetch", async () => {
    let cancelled = false;
    // A body that stays open until cancelled — the pump blocks on read()
    // until the fetch's abort (emulated here via controller.error) errors it.
    let errorBody: (e: unknown) => void = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'),
        );
        errorBody = (e) => controller.error(e);
      },
    });
    const handle = streamSse(body, buildCost, () => {
      cancelled = true;
      errorBody(new Error("aborted"));
    });
    const fiber = Effect.runFork(Stream.runCollect(handle.deltas));
    await new Promise((r) => setTimeout(r, 30)); // let the first delta flow
    await Effect.runPromise(Fiber.interrupt(fiber) as Effect.Effect<unknown, never, never>);
    expect(cancelled).toBe(true);
    // The deferred cost fails: a cancelled generation cannot be metered.
    const costExit = await Effect.runPromiseExit(handle.cost());
    const failure =
      costExit._tag === "Failure"
        ? Cause.failureOption(costExit.cause)
        : Option.none<ProviderError>();
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) {
      expect(failure.value).toMatchObject({ kind: "transport" });
    }
  });

  it("a mid-flight body failure fails the deferred cost as a transport error", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
        controller.error(new Error("wire cut"));
      },
    });
    const handle = streamSse(body, buildCost, () => {});
    const exit = await Effect.runPromiseExit(Stream.runCollect(handle.deltas));
    expect(exit._tag).toBe("Failure");
    const costExit = await Effect.runPromiseExit(handle.cost());
    const failure =
      costExit._tag === "Failure"
        ? Cause.failureOption(costExit.cause)
        : Option.none<ProviderError>();
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) expect(failure.value.kind).toBe("transport");
  });
});
