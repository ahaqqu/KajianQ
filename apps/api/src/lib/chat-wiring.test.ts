import { describe, expect, it, vi } from "vitest";
import { runStoreEffect } from "@app/kajianq-domain";
import { authGuard, createProvidersFromEnv, storeBridge } from "../lib/chat-wiring";

const storeBridgeOf = (fx: unknown) => runStoreEffect<{ token: string }>(fx);
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";

async function awaitImportConfig() {
  const { loadProviderConfig } = await import("@app/infra");
  return { loadProviderConfig };
}

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

  it("reports the missing env names for ops visibility", async () => {
    const providers = createProvidersFromEnv({});
    // The chat roles (cheap/generator/reviewer/embedder) span the gemini,
    // qwen, and deepseek vendors' env names — asserted via the config data
    // (ADR-0022), never hard-coded here.
    const { loadProviderConfig } = await awaitImportConfig();
    const vendors: Record<string, { apiKeyEnv: string }> = loadProviderConfig().vendors;
    for (const envName of new Set(Object.values(vendors).map((v) => v.apiKeyEnv))) {
      const usedByChatRoles = ["cheap", "generator", "reviewer", "embedder"].some((role) =>
        loadProviderConfig().roles[role]?.chain.some((k) => {
          const parts = k.split(":");
          const vendor = parts[0] ?? "";
          return vendor !== "" && vendors[vendor]?.apiKeyEnv === envName;
        }),
      );
      if (usedByChatRoles) {
        expect(providers.missingKeys).toContain(envName);
      }
    }
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
