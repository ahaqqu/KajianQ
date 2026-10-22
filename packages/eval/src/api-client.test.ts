import { describe, expect, it } from "vite-plus/test";
import {
  ChatTransportError,
  consumeSseToText,
  parseChatMeta,
  parseCitationsFrame,
  postChatSse,
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

  it("captures the citations frame's grounded labels and their text (ADR-0040)", async () => {
    // The wire order is meta → deltas → citations → trace → done; the scorer
    // reads these labels in preference to re-parsing the answer text, and the
    // text travels with them because quote fidelity is measured against it.
    const { body } = sseResponse([
      'event: meta\ndata: {"messageId":"m1","traceId":"t1"}\n\n',
      "event: delta\ndata: the answer cites \n\n",
      "event: delta\ndata: alpha\n\n",
      'event: citations\ndata: {"messageId":"m1","citations":[{"label":"alpha","arabic":"x","machineTranslated":true}],"refusal":false}\n\n',
      'event: trace\ndata: {"messageId":"m1","sources":[],"technical":{"subQueries":[],"chunks":[],"models":[]}}\n\n',
      "event: done\ndata: {}\n\n",
    ]);
    const result = await consumeSseToText(body);
    expect(result.text).toBe("the answer cites alpha");
    expect(result.citations).toEqual({ citations: [{ label: "alpha", arabic: "x" }] });
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
    // The real frame also carries the product's weak-grade display flag; this
    // engine-package test omits it deliberately (the boundary gate forbids
    // domain vocabulary here) — the parser ignores it, so the labels it reads
    // are the same.
    expect(
      parseCitationsFrame(
        '{"messageId":"m","citations":[{"label":"label-a"},{"label":"label-b"}],"refusal":false}',
      ),
    ).toEqual({ citations: [{ label: "label-a" }, { label: "label-b" }] });
  });

  it("returns null when the payload has no citations array", () => {
    expect(parseCitationsFrame('{"messageId":"m","refusal":true}')).toBeNull();
  });

  it("skips entries with a non-string or empty label", () => {
    expect(
      parseCitationsFrame('{"citations":[{"label":""},{"label":42},{"label":"kept"}]}'),
    ).toEqual({ citations: [{ label: "kept" }] });
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

/**
 * The transport error's `status` and `phase` are the seam a caller reads to tell
 * "the target is not serving" (a readiness question) from "the target answered and
 * the answer was bad" (an eval result). It must therefore survive every way a
 * round-trip can fail without an answer: an edge rejection carries the status and
 * `response` phase, a failed connection carries `null` and `connect`, and a broken
 * stream carries `null` and `stream` — the last two are deliberately distinguishable
 * because only the first never got response headers. The message is what the run log
 * prints, so a status rejection keeps the exact `/v1/chat returned <status>: <body>`
 * shape.
 */
describe("postChatSse", () => {
  const input = { baseUrl: "https://staging.example", token: "t-1", question: "q" };

  it("returns the consumed SSE result on a 200", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode(
            'event: meta\ndata: {"messageId":"m1","traceId":"t1"}\n\nevent: delta\ndata: hello\n\n',
          ),
        );
        controller.close();
      },
    });
    const result = await postChatSse({
      ...input,
      fetchImpl: async () =>
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    expect(result.text).toBe("hello");
    expect(result.messageId).toBe("m1");
    expect(result.traceId).toBe("t1");
  });

  it("carries the edge status on a 502, with the body in the message", async () => {
    const err = await postChatSse({
      ...input,
      fetchImpl: async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatTransportError);
    expect((err as ChatTransportError).status).toBe(502);
    expect((err as ChatTransportError).phase).toBe("response");
    expect((err as ChatTransportError).detail).toContain("502 Bad Gateway");
    expect((err as Error).message).toBe("/v1/chat returned 502: <html>502 Bad Gateway</html>");
  });

  it("carries a null status when the connection fails, naming the cause", async () => {
    const err = await postChatSse({
      ...input,
      fetchImpl: async () => {
        throw new TypeError("fetch failed", { cause: new Error("Connection refused") });
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatTransportError);
    expect((err as ChatTransportError).status).toBeNull();
    expect((err as ChatTransportError).phase).toBe("connect");
    expect((err as Error).message).toBe(
      "/v1/chat request failed: fetch failed: Connection refused",
    );
  });

  it("carries a null status when the stream breaks after the headers", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("ECONNRESET");
      },
    });
    const err = await postChatSse({
      ...input,
      fetchImpl: async () =>
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatTransportError);
    expect((err as ChatTransportError).status).toBeNull();
    expect((err as ChatTransportError).phase).toBe("stream");
    expect((err as Error).message).toBe("/v1/chat request failed: stream failed: ECONNRESET");
  });
});
