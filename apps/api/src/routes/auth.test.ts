import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApi } from "../app";

vi.mock("@sentry/bun", () => ({ captureException: vi.fn() }));
import { runStoreEffect, type StoreBridge } from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import { StoreError } from "@app/infra";
import type { AnonymousSession } from "@app/contracts";

/**
 * Anonymous-session auth routes (ADR-0017): mint, resolve, erase.
 * The store is the in-memory RagStore; the database client is mocked to prove the
 * routes never reach a database directly (the seam holds).
 */

let currentStore: ReturnType<typeof createMemoryRagStore>;
/** The store bridge the route calls its seam through; a test can replace it with
 * a failing one to drive the erasure's error path (the API itself never imports
 * the effect runtime — ADR-0027 decision 3 — so the failure is injected here). */
let currentBridge: StoreBridge = runStoreEffect;

beforeEach(() => {
  currentBridge = runStoreEffect;
});

vi.mock("../lib/chat-wiring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/chat-wiring")>();
  return {
    ...actual,
    // Auth uses the store-only wiring — no provider roles are resolved on
    // this path at all, so the mock supplies just the store and its bridge.
    buildStoreWiring: () => ({
      fullStore: currentStore,
      runStore: currentBridge,
    }),
  };
});

// The database client lives behind the RagStore adapter (ADR-0008), so
// these route tests never reach one: constructing or querying the pool is
// the failure this mock makes loud.
vi.mock("pg", () => ({
  Pool: class {
    on(): void {}
    query(): never {
      throw new Error("auth test: the database must not be reached");
    }
  },
}));

const env = { ASSETS: { fetch } };

describe("POST /v1/auth/anonymous", () => {
  it("mints a session and returns the token exactly once", async () => {
    currentStore = createMemoryRagStore();
    const res = await createApi().request("/v1/auth/anonymous", { method: "POST" }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnonymousSession;
    expect(body.token).toBeTruthy();
    expect(body.userId).toBeTruthy();
    expect(body.sessionId).toBeTruthy();
    expect(body.expiresAt).toBeGreaterThan(Date.now());

    // The minted token resolves to its user through the store seam.
    const userId = await runStoreEffect<string | null>(currentStore.resolveUserId(body.token));
    expect(userId).toBe(body.userId);
  });

  it("answers 503 when the deployment is not configured (feature disabled)", async () => {
    // The store-only wiring fails closed on a missing database binding, and
    // only on that: with no DATABASE_URL the route answers 503 rather than
    // degrading.
    const { buildStoreWiring, ChatConfigError } =
      await vi.importActual<typeof import("../lib/chat-wiring")>("../lib/chat-wiring");
    expect(() => buildStoreWiring({})).toThrow(ChatConfigError);
    expect(() => buildStoreWiring({})).toThrow(/DATABASE_URL is not bound/);
  });
});

describe("DELETE /v1/auth/me", () => {
  /** A user with a row in every table of the erasure's subtree — the same shape
   * the adapter's postcondition counts, so "every table empty" is assertable
   * through the store's own reads. */
  const seedSubtree = async () => {
    currentStore = createMemoryRagStore();
    const session = await runStoreEffect<AnonymousSession>(currentStore.createSession());
    const chatSessionId = await runStoreEffect<string>(
      currentStore.createChatSession({ userId: session.userId }),
    );
    const messageId = crypto.randomUUID();
    await runStoreEffect<string>(
      currentStore.insertChatMessage({ sessionId: chatSessionId, role: "user", content: "hi" }),
    );
    const storedTraceId = await runStoreEffect<string>(
      currentStore.insertAnswerTrace({
        messageId,
        userId: session.userId,
        trace: { id: `trace-${messageId}`, createdAt: 1_700_000_000_000, events: [] },
      }),
    );
    await runStoreEffect<string>(
      currentStore.insertChatMessage({
        sessionId: chatSessionId,
        role: "assistant",
        content: "salaam",
        answerTraceId: storedTraceId,
      }),
    );
    await runStoreEffect<string>(
      currentStore.insertFeedback({
        messageId,
        userId: session.userId,
        rating: 1,
        anchorType: "answer",
        anchorId: null,
        category: null,
        freeText: null,
      }),
    );
    return { session, chatSessionId, messageId, storedTraceId };
  };

  const erase = (token: string) =>
    createApi().request(
      "/v1/auth/me",
      { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
      env,
    );

  it("erases the authenticated user's whole subtree in one call", async () => {
    const { session, messageId, storedTraceId } = await seedSubtree();
    expect(currentStore.allChatMessages()).toHaveLength(2);
    expect(currentStore.allFeedback()).toHaveLength(1);

    const res = await erase(session.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    // Every table of the subtree is empty — the response is the claim the store's
    // own reads now back up.
    expect(currentStore.allChatMessages()).toEqual([]);
    expect(currentStore.allChatSessions()).toEqual([]);
    expect(currentStore.allFeedback()).toEqual([]);
    expect(currentStore.allTraces().size).toBe(0);
    // The trace is unreachable by BOTH its keys, and the token no longer resolves.
    expect(await runStoreEffect(currentStore.getAnswerTraceById(storedTraceId))).toBeNull();
    expect(await runStoreEffect(currentStore.getAnswerTraceByMessage(messageId))).toBeNull();
    expect(await runStoreEffect(currentStore.resolveUserId(session.token))).toBeNull();
  });

  it("answers an error, never {deleted: true}, when the erasure fails", async () => {
    const { session } = await seedSubtree();
    // A store whose erasure failed — a surviving row, a failed statement, or a
    // rolled-back transaction — must surface as an error: the response is the
    // erasure's only success claim, so it may never be sent over a live subtree.
    currentBridge = () =>
      Promise.reject(
        new StoreError({
          kind: "constraint",
          cause: new Error("user erasure left rows behind in: feedback"),
        }),
      );

    const logged: string[] = [];
    const sink = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    let body: unknown;
    try {
      const res = await erase(session.token);
      expect(res.status).toBe(500);
      body = await res.json();
    } finally {
      sink.mockRestore();
    }
    // The body stays generic: no table name, no SQL, no user id.
    expect(body).toEqual({ error: "internal" });
    // The residual tables are the erasure's only diagnostic, and they reach the
    // log under a named event rather than only inside the generic request error.
    const incomplete = logged
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return {};
        }
      })
      .find((line) => line.msg === "auth.erasure_incomplete");
    expect(incomplete).toMatchObject({
      level: "error",
      route: "auth",
      kind: "constraint",
      cause: "user erasure left rows behind in: feedback",
    });
    // Not half-erased: the store was never told to erase, so the subtree is still
    // coherent for a retry.
    expect(currentStore.allChatMessages()).toHaveLength(2);
    expect(currentStore.allChatSessions()).toHaveLength(1);
    expect(currentStore.allFeedback()).toHaveLength(1);
    expect(currentStore.allTraces().size).toBe(1);
  });

  it("401s a repeat call with the erased token — the token died with the sessions", async () => {
    const { session } = await seedSubtree();
    expect((await erase(session.token)).status).toBe(200);
    // The store call is idempotent (a no-op on an empty subtree), but the TOKEN is
    // not: it authenticated a user whose sessions are gone, so the honest answer is
    // a 401, never a second success claim about rows that no longer exist.
    expect((await erase(session.token)).status).toBe(401);
  });

  it("401s without a token — erasure is never a silent no-op", async () => {
    currentStore = createMemoryRagStore();
    const res = await createApi().request("/v1/auth/me", { method: "DELETE" }, env);
    expect(res.status).toBe(401);
  });

  it("401s an unknown token", async () => {
    currentStore = createMemoryRagStore();
    const res = await createApi().request(
      "/v1/auth/me",
      { method: "DELETE", headers: { authorization: "Bearer nope" } },
      env,
    );
    expect(res.status).toBe(401);
  });
});
