import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  bootstrapAnonymousToken,
  CHAT_HISTORY_LIMIT,
  ChatApiError,
  HISTORY_KEY,
  archiveChatFromMessages,
  archiveChatSession,
  clearChatHistory,
  clearStoredSessionId,
  loadChatHistory,
  markChatSessionExpired,
  removeChatHistoryEntry,
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
        truncated: false,
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
    stubFetch(() =>
      Response.json({ sessionId: "s", truncated: false, messages: [{ id: "m0", role: "system" }] }),
    );
    const err = await fetchSessionMessages("sess-1", "tok").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ChatApiError); // valibot throws, loudly
  });

  it("a transcript without the truncated marker fails the contract (thermo-review A4)", async () => {
    stubFetch(() => Response.json({ sessionId: "s", messages: [] }));
    const err = await fetchSessionMessages("sess-1", "tok").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ChatApiError); // valibot throws, loudly
  });
});

describe("conversation history", () => {
  afterEach(() => {
    clearChatHistory();
  });

  it("records a conversation at the front and re-archiving keeps its start time", () => {
    archiveChatSession({ id: "a", title: "First", locale: "id", startedAt: 1 });
    archiveChatSession({ id: "b", title: "Second", locale: "en", startedAt: 2 });
    expect(loadChatHistory().map((row) => row.id)).toEqual(["b", "a"]);

    archiveChatSession({ id: "a", title: "First again", locale: "id", startedAt: 99 });
    const rows = loadChatHistory();
    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(rows[0]).toMatchObject({ title: "First again", startedAt: 1 });
  });

  it("caps the list at the limit, dropping the oldest", () => {
    for (let i = 0; i < CHAT_HISTORY_LIMIT + 3; i++) {
      archiveChatSession({ id: `s${i}`, title: `Q${i}`, locale: "id", startedAt: i });
    }
    const rows = loadChatHistory();
    expect(rows).toHaveLength(CHAT_HISTORY_LIMIT);
    expect(rows[0]?.id).toBe(`s${CHAT_HISTORY_LIMIT + 2}`);
    expect(rows.some((row) => row.id === "s0")).toBe(false);
  });

  it("marks an expired row without dropping it, and removes on request", () => {
    archiveChatSession({ id: "a", title: "First", locale: "id", startedAt: 1 });
    markChatSessionExpired("a");
    expect(loadChatHistory()[0]?.expired).toBe(true);
    removeChatHistoryEntry("a");
    expect(loadChatHistory()).toEqual([]);
  });

  it("archives from messages only when a first question exists", () => {
    archiveChatFromMessages({
      id: "a",
      locale: "id",
      messages: [
        { id: "m1", role: "assistant", content: "Hi", createdAt: 5 },
        { id: "m2", role: "user", content: "Apa itu tafsir?", createdAt: 6 },
      ],
    });
    expect(loadChatHistory()[0]).toMatchObject({ title: "Apa itu tafsir?", startedAt: 6 });

    archiveChatFromMessages({ id: "b", locale: "id", messages: [] });
    expect(loadChatHistory().map((row) => row.id)).toEqual(["a"]);
  });

  it("survives malformed stored JSON by reading as no history", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    store.set(HISTORY_KEY, "{not json");
    expect(loadChatHistory()).toEqual([]);
    store.set(HISTORY_KEY, JSON.stringify([{ id: "a" }]));
    expect(loadChatHistory()).toEqual([]);
  });
});
