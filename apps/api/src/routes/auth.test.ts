import { describe, expect, it, vi } from "vitest";
import { createApi } from "../app";

vi.mock("@sentry/cloudflare", () => ({ captureException: vi.fn() }));
import { runStoreEffect } from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import type { AnonymousSession } from "@app/contracts";

/**
 * Anonymous-session auth routes (ADR-0017, ticket #10): mint, resolve, erase.
 * The store is the in-memory RagStore; the Neon client is mocked to prove the
 * routes never reach a database directly (the seam holds).
 */

let currentStore: ReturnType<typeof createMemoryRagStore>;

vi.mock("../lib/chat-wiring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/chat-wiring")>();
  return {
    ...actual,
    // A4: auth uses the store-only wiring — no provider roles are resolved on
    // this path at all, so the mock supplies just the store and its bridge.
    buildStoreWiring: () => ({
      fullStore: currentStore,
      runStore: runStoreEffect,
    }),
  };
});

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    throw new Error("auth test: neon must not be reached");
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
  it("erases the authenticated user and their data", async () => {
    currentStore = createMemoryRagStore();
    const session = await runStoreEffect<AnonymousSession>(currentStore.createSession());
    // Give the user a chat session + message so the cascade has something to
    // erase (the memory store's deleteUserCascade is a no-op stand-in for the
    // Neon FK cascade; the route's contract is that it is called once, with
    // the authenticated user id).
    const chatSessionId = await runStoreEffect<string>(
      currentStore.createChatSession({ userId: session.userId }),
    );
    await runStoreEffect<string>(
      currentStore.insertChatMessage({ sessionId: chatSessionId, role: "user", content: "hi" }),
    );

    const res = await createApi().request(
      "/v1/auth/me",
      { method: "DELETE", headers: { authorization: `Bearer ${session.token}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
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
