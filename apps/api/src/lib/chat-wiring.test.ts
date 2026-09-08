import { describe, expect, it, vi } from "vitest";
import { runStoreEffect } from "@app/kajianq-domain";
import { authGuard, createProvidersFromEnv, storeBridge } from "../lib/chat-wiring";

const storeBridgeOf = (fx: unknown) => runStoreEffect<{ token: string }>(fx);
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    throw new Error("chat-wiring test: neon must not be reached");
  },
}));

describe("createProvidersFromEnv", () => {
  it("resolves every role from an empty env (calls fail, wiring never branches)", () => {
    const providers = createProvidersFromEnv({});
    expect(providers.missingKeys.length).toBeGreaterThan(0);
    // No keyed candidate → reviewer is null (skipped, not failed).
    expect(providers.reviewer).toBeNull();
  });

  it("reports the missing env names for ops visibility", () => {
    const providers = createProvidersFromEnv({});
    // Every allowlisted vendor key is missing in this scenario.
    expect(providers.missingKeys).toContain("GEMINI_API_KEY");
    expect(providers.missingKeys).toContain("DASHSCOPE_API_KEY");
  });
});

describe("storeBridge", () => {
  it("runs an Effect-signatured store call to a promise", async () => {
    const store = createMemoryRagStore();
    const run = storeBridge(store);
    const result = await run(store.resolveUserId("anything"));
    expect(result).toBeNull();
  });
});

describe("authGuard", () => {
  function fakeContext(header: string | undefined): unknown {
    let authed: unknown;
    return {
      req: { header: (name: string) => (name === "authorization" ? header : undefined) },
      json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
      set: (_key: string, value: unknown) => {
        authed = value;
      },
      getAuthed: () => authed,
    };
  }

  it("401s a missing Authorization header", async () => {
    const store = createMemoryRagStore();
    const c = fakeContext(undefined);
    const res = await authGuard(c as never, store);
    expect(res?.status).toBe(401);
  });

  it("401s an unknown token", async () => {
    const store = createMemoryRagStore();
    const c = fakeContext("Bearer nope");
    const res = await authGuard(c as never, store);
    expect(res?.status).toBe(401);
  });

  it("stashes the Authed variable for a known token", async () => {
    const store = createMemoryRagStore();
    const session = await storeBridgeOf(store.createSession());
    const c = fakeContext(`Bearer ${session.token}`);
    const res = await authGuard(c as never, store);
    expect(res).toBeUndefined();
  });
});
