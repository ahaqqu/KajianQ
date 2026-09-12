import { describe, expect, it } from "vitest";
import { parseSseStream } from "./sse";

/** Build a ReadableStream from string chunks, as fetch's body delivers. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<{ event: string; data: string }[]> {
  const frames: { event: string; data: string }[] = [];
  for await (const frame of parseSseStream(body)) frames.push(frame);
  return frames;
}

describe("parseSseStream", () => {
  it("parses meta, deltas, citations, and done frames in wire order", async () => {
    const frames = await collect(
      streamOf(
        'event: meta\ndata: {"sessionId":"s1","messageId":"m1","traceId":"t1"}\n\n',
        "event: delta\ndata: Ayat \n\n",
        "event: delta\ndata: kursi.\n\n",
        'event: citations\ndata: {"messageId":"m1","citations":[],"refusal":false,"dhaifWarning":false}\n\n',
        "event: done\ndata: {}\n\n",
      ),
    );
    expect(frames.map((f) => f.event)).toEqual(["meta", "delta", "delta", "citations", "done"]);
    expect(JSON.parse(frames[0]!.data)).toMatchObject({ sessionId: "s1" });
  });

  it("joins a frame's multiple data lines with \\n (multi-line payloads survive)", async () => {
    const frames = await collect(streamOf("event: delta\ndata: line1\ndata: line2\n\n"));
    expect(frames[0]?.data).toBe("line1\nline2");
  });

  it("keeps meaningful leading spaces but strips the one after the colon", async () => {
    const frames = await collect(streamOf("event: delta\ndata:  indented\n\n"));
    expect(frames[0]?.data).toBe(" indented");
  });

  it("handles frames split across chunk boundaries and \\r\\n endings", async () => {
    const frames = await collect(
      streamOf("event: del", "ta\ndata: split\r\n\r", "\n", "event: done\ndata: {}\n\n"),
    );
    expect(frames.map((f) => f.event)).toEqual(["delta", "done"]);
    expect(frames[0]?.data).toBe("split");
  });

  it("yields unknown frame types (the consumer decides what to ignore)", async () => {
    const frames = await collect(streamOf("event: future_thing\ndata: x\n\n"));
    expect(frames).toEqual([{ event: "future_thing", data: "x" }]);
  });

  it("skips comment and blank frames, and terminates a final frame at stream close", async () => {
    const frames = await collect(streamOf(": keep-alive\n\n", "event: delta\ndata: tail"));
    expect(frames).toEqual([{ event: "delta", data: "tail" }]);
  });
});
