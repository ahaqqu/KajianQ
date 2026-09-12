import { afterEach, describe, expect, it, vi } from "vitest";
import { askChat } from "./chat-client";
import { clearStoredSessionId, loadStoredSessionId, saveStoredToken } from "./chat-store";

/**
 * The stream consumer's contract: frames drive the handlers in wire order,
 * multiple deltas append, the citations frame is consumed whole (never
 * parsed out of the answer text), 401 re-bootstraps the token and retries
 * exactly once, and rate limiting maps to a typed error.
 */

const META = 'event: meta\ndata: {"sessionId":"s-9","messageId":"m-1","traceId":"t-1"}\n\n';
const CITATIONS =
  'event: citations\ndata: {"messageId":"m-1","citations":[{"label":"QS. 2:255","arabic":"ا","machineTranslated":false}],"refusal":false,"dhaifWarning":true}\n\n';

/** SSE Response built from raw frame strings. */
function sseResponse(frames: string[], status = 200): Response {
  return new Response(frames.join(""), {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function stubFetchSequence(responses: Response[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const res of responses) fn.mockImplementationOnce(() => Promise.resolve(res));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearStoredSessionId();
  saveStoredToken("");
});

describe("askChat", () => {
  it("streams meta, deltas, and citations in wire order and persists the session", async () => {
    const fetchFn = stubFetchSequence([
      sseResponse([
        META,
        "event: delta\ndata: satu \n\n",
        "event: delta\ndata: dua\n\n",
        CITATIONS,
        "event: done\ndata: {}\n\n",
      ]),
    ]);
    const seen: string[] = [];
    const result = await askChat(
      { message: "q", sessionId: null, language: "id" },
      {
        onMeta: (m) => seen.push(`meta:${m.sessionId}`),
        onDelta: (t) => seen.push(`delta:${t}`),
        onCitations: (f) => seen.push(`citations:${f.citations.length}:${f.dhaifWarning}`),
      },
      "tok-1",
    );
    expect(seen).toEqual(["meta:s-9", "delta:satu ", "delta:dua", "citations:1:true"]);
    expect(result.sessionId).toBe("s-9");
    expect(loadStoredSessionId()).toBe("s-9");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/chat");
    expect(JSON.parse(String(init.body))).toEqual({ message: "q", language: "id" });
  });

  it("sends the stored sessionId on follow-ups", async () => {
    const fetchFn = stubFetchSequence([sseResponse([META, "event: done\ndata: {}\n\n"])]);
    await askChat({ message: "q", sessionId: "s-9", language: "en" }, {}, "tok-1");
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      message: "q",
      sessionId: "s-9",
      language: "en",
    });
  });

  it("on 401 re-bootstraps the token silently and retries exactly once", async () => {
    const fetchFn = stubFetchSequence([
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      Response.json({ userId: "u", sessionId: "s", token: "tok-fresh", expiresAt: 1 }),
      sseResponse([META, "event: done\ndata: {}\n\n"]),
    ]);
    const result = await askChat({ message: "q", sessionId: null, language: "id" }, {}, "stale");
    expect(fetchFn).toHaveBeenCalledTimes(3); // 401, mint, retry
    expect(result.token).toBe("tok-fresh");
    expect(result.sessionId).toBe("s-9");
  });

  it("maps 429 to a typed rate_limited error (no retry)", async () => {
    const fetchFn = stubFetchSequence([
      new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 }),
    ]);
    const err = await askChat(
      { message: "q", sessionId: null, language: "id" },
      {},
      "tok-1",
    ).catch((e: unknown) => e);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((err as Error).name).toBe("ChatApiError");
    expect((err as { kind: string }).kind).toBe("rate_limited");
  });

  it("a malformed citations frame is skipped; the streamed answer stands", async () => {
    stubFetchSequence([
      sseResponse([META, "event: delta\ndata: jawaban\n\n", "event: citations\ndata: {broken\n\n", "event: done\ndata: {}\n\n"]),
    ]);
    const seen: string[] = [];
    await askChat(
      { message: "q", sessionId: null, language: "id" },
      {
        onDelta: (t) => seen.push(t),
        onCitations: () => seen.push("citations"),
      },
      "tok-1",
    );
    expect(seen).toEqual(["jawaban"]);
  });

  it("a stream without meta fails loudly (session identity is load-bearing)", async () => {
    stubFetchSequence([sseResponse(["event: done\ndata: {}\n\n"])]);
    const err = await askChat({ message: "q", sessionId: null, language: "id" }, {}, "tok-1").catch(
      (e: unknown) => e,
    );
    expect((err as { kind: string }).kind).toBe("bad_response");
  });
});
