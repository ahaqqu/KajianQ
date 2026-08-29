import { describe, expect, it } from "vitest";
import { readSseStream, wrapSseStream } from "./sse-stream";

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

describe("wrapSseStream", () => {
  const buildCost = (usage: { prompt_tokens?: number } | undefined, charCount: number) => ({
    modelId: "m",
    tokensIn: usage?.prompt_tokens ?? 0,
    tokensOut: charCount,
    latencyMs: 1,
    costMicroUsd: 1,
    estimated: usage === undefined,
  });

  it("cost() resolves without consuming deltas (no deadlock)", async () => {
    const handle = wrapSseStream(
      sseBody([
        'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
      ]),
      buildCost as never,
    );
    const cost = await handle.cost(); // must not hang
    expect(cost.tokensIn).toBe(7);
  });

  it("cost() resolves after deltas are fully consumed", async () => {
    const handle = wrapSseStream(
      sseBody(['data: {"choices":[{"delta":{"content":"abc"}}]}\n\n', "data: [DONE]\n\n"]),
      buildCost as never,
    );
    const text = (await collect(handle.deltas)).join("");
    expect(text).toBe("abc");
    const cost = await handle.cost();
    expect(cost.estimated).toBe(true); // no usage chunk
  });
});