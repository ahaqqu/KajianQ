import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapAnonymousToken,
  ChatApiError,
  clearStoredSessionId,
  fetchSessionMessages,
  loadStoredSessionId,
  loadStoredToken,
  saveStoredSessionId,
} from "./chat-store";

/** fetch stub returning a canned Response. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => handler(String(url), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearStoredSessionId();
});

describe("session persistence", () => {
  it("round-trips the session id through the storage wrapper", () => {
    expect(loadStoredSessionId()).toBeNull();
    saveStoredSessionId("sess-9");
    expect(loadStoredSessionId()).toBe("sess-9");
    clearStoredSessionId();
    expect(loadStoredSessionId()).toBeNull();
  });

  it("survives a blocked localStorage (values keep for the page lifetime)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    saveStoredSessionId("sess-mem");
    expect(loadStoredSessionId()).toBe("sess-mem");
    clearStoredSessionId();
    expect(loadStoredSessionId()).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("bootstrapAnonymousToken", () => {
  it("mints, parses, and persists the anonymous token", async () => {
    const fetchFn = stubFetch((url) => {
      expect(url).toContain("/v1/auth/anonymous");
      return Response.json({ userId: "u1", sessionId: "s1", token: "tok-1", expiresAt: 1 });
    });
    const token = await bootstrapAnonymousToken();
    expect(token).toBe("tok-1");
    expect(loadStoredToken()).toBe("tok-1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("maps failure statuses to typed errors (429 rate limit)", async () => {
    stubFetch(() => Response.json({ error: "rate_limited" }, { status: 429 }));
    const err = await bootstrapAnonymousToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatApiError);
    expect((err as ChatApiError).kind).toBe("rate_limited");
  });
});

describe("fetchSessionMessages", () => {
  it("rehydrates and contract-parses the transcript", async () => {
    stubFetch((url) => {
      expect(url).toContain("/v1/chat/sessions/sess-1/messages");
      return Response.json({
        sessionId: "sess-1",
        messages: [
          { id: "m0", role: "user", content: "q", createdAt: 1 },
          { id: "m1", role: "assistant", content: "a", createdAt: 2 },
        ],
      });
    });
    const body = await fetchSessionMessages("sess-1", "tok");
    expect(body.messages).toHaveLength(2);
  });

  it("a foreign session is a 404 typed error (no existence leak)", async () => {
    stubFetch(() => Response.json({ error: "invalid_request" }, { status: 404 }));
    const err = await fetchSessionMessages("other", "tok").catch((e: unknown) => e);
    expect((err as ChatApiError).kind).toBe("bad_response");
    expect((err as ChatApiError).status).toBe(404);
  });

  it("rejects a malformed transcript (contract is the boundary)", async () => {
    stubFetch(() => Response.json({ sessionId: "s", messages: [{ id: "m0", role: "system" }] }));
    const err = await fetchSessionMessages("sess-1", "tok").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ChatApiError); // valibot throws, loudly
  });
});
