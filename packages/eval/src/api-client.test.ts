import { describe, expect, it } from "vitest";
import {
  consumeSseToText,
  parseChatMeta,
  parseCitationsFrame,
  type ChatSseResult,
} from "./api-client";

/** SSE-consume unit tests: pure stream parsing, no network. */

function sseResponse(frames: string[]): { body: ReadableStream<Uint8Array> } {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(enc.encode(frame));
      controller.close();
    },
  });
  return { body };
}

describe("consumeSseToText", () => {
  it("buffers delta frames into the full text", async () => {
    const { body } = sseResponse([
      'event: meta\ndata: {"messageId":"m1","traceId":"t1"}\n\n',
      "event: delta\ndata: hello \n\n",
      "event: delta\ndata: world\n\n",
      "event: done\ndata: {}\n\n",
    ]);
    const result: ChatSseResult = await consumeSseToText(body);
    expect(result.text).toBe("hello world");
    expect(result.messageId).toBe("m1");
    expect(result.traceId).toBe("t1");
    expect(result.events).toHaveLength(4);
  });

  it("joins multi-line data fields with newlines", async () => {
    const { body } = sseResponse(["event: delta\ndata: line1\ndata: line2\n\n"]);
    const result = await consumeSseToText(body);
    expect(result.text).toBe("line1\nline2");
  });

  it("strips one leading space after the colon, not all leading whitespace", async () => {
    // The route emits `data: ${line}`, so a delta that itself begins with a
    // space arrives as two spaces after the colon. Only the first is the SSE
    // field separator; the second belongs to the answer.
    const { body } = sseResponse(["event: delta\ndata:  indented\n\n"]);
    const result = await consumeSseToText(body);
    expect(result.text).toBe(" indented");
  });

  it("keeps a citation intact when the route splits it across deltas", async () => {
    // Live-staging regression (gs-v0-002): the vendor streamed "QS." and
    // " 2:43" as separate deltas. `trimStart()` dropped the space, the harness
    // reassembled "QS.2:43", and a correctly cited answer scored
    // citationValidity 0 while the persisted answer and the reviewer both
    // held the true text.
    const { body } = sseResponse([
      "event: delta\ndata: dalil QS.\n\n",
      "event: delta\ndata:  2:43 tentang shalat\n\n",
    ]);
    const result = await consumeSseToText(body);
    expect(result.text).toBe("dalil QS. 2:43 tentang shalat");
  });

  it("ignores comment frames and blank frames", async () => {
    const { body } = sseResponse([": keep-alive\n\n", "event: delta\ndata: x\n\n"]);
    const result = await consumeSseToText(body);
    expect(result.text).toBe("x");
    expect(result.events).toHaveLength(1);
  });

  it("records but tolerates a malformed meta payload", async () => {
    const { body } = sseResponse(["event: meta\ndata: {broken\n\n", "event: delta\ndata: y\n\n"]);
    const result = await consumeSseToText(body);
    expect(result.messageId).toBeNull();
    expect(result.text).toBe("y");
  });

  it("captures the citations frame's grounded labels (ADR-0040)", async () => {
    // The wire order is meta → deltas → citations → trace → done; the scorer
    // reads these labels in preference to re-parsing the answer text.
    const { body } = sseResponse([
      'event: meta\ndata: {"messageId":"m1","traceId":"t1"}\n\n',
      "event: delta\ndata: The answer cites QS.\n\n",
      "event: delta\ndata:  1:2\n\n",
      'event: citations\ndata: {"messageId":"m1","citations":[{"label":"QS. 1:2","arabic":"x","machineTranslated":true}],"refusal":false,"dhaifWarning":false}\n\n',
      'event: trace\ndata: {"messageId":"m1","sources":[],"technical":{"subQueries":[],"chunks":[],"models":[]}}\n\n',
      "event: done\ndata: {}\n\n",
    ]);
    const result = await consumeSseToText(body);
    expect(result.text).toBe("The answer cites QS. 1:2");
    expect(result.citations).toEqual({ citations: [{ label: "QS. 1:2" }] });
  });

  it("leaves citations null when the frame is absent", async () => {
    const { body } = sseResponse(["event: delta\ndata: plain answer\n\n"]);
    const result = await consumeSseToText(body);
    expect(result.citations).toBeNull();
  });

  it("leaves citations null for a malformed frame instead of a partial read", async () => {
    const { body } = sseResponse(["event: citations\ndata: {broken\n\n"]);
    const result = await consumeSseToText(body);
    expect(result.citations).toBeNull();
  });
});

describe("parseCitationsFrame", () => {
  it("extracts the labels from a well-formed frame", () => {
    expect(
      parseCitationsFrame(
        '{"messageId":"m","citations":[{"label":"QS. 1:2"},{"label":"HR. Malik no. 187"}],"refusal":false,"dhaifWarning":false}',
      ),
    ).toEqual({ citations: [{ label: "QS. 1:2" }, { label: "HR. Malik no. 187" }] });
  });

  it("returns null when the payload has no citations array", () => {
    expect(parseCitationsFrame('{"messageId":"m","refusal":true}')).toBeNull();
  });

  it("skips entries with a non-string or empty label", () => {
    expect(
      parseCitationsFrame('{"citations":[{"label":""},{"label":42},{"label":"QS. 2:255"}]}'),
    ).toEqual({ citations: [{ label: "QS. 2:255" }] });
  });

  it("returns null for junk rather than throwing", () => {
    expect(parseCitationsFrame("junk")).toBeNull();
  });
});

describe("parseChatMeta", () => {
  it("extracts ids from a meta frame", () => {
    expect(parseChatMeta('{"messageId":"m","traceId":"t"}')).toEqual({
      messageId: "m",
      traceId: "t",
    });
  });
  it("returns nulls + the bounded raw payload for junk input (B6)", () => {
    expect(parseChatMeta("junk")).toEqual({
      messageId: null,
      traceId: null,
      malformed: "junk",
    });
  });
});
