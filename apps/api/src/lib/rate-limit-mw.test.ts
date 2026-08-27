import { describe, expect, it } from "vitest";
import { createMemoryRateLimiter } from "@app/infra";
import type { WorkerBindings } from "../env";
import { allowRequest, resolveRateLimiter } from "./rate-limit-mw";

describe("allowRequest", () => {
  it("allows under limit", async () => {
    const limiter = createMemoryRateLimiter();
    expect(await allowRequest("t1", limiter, 5, 60_000)).toBe(true);
  });
});

describe("resolveRateLimiter", () => {
  it("uses the in-memory fallback without a binding", async () => {
    const limiter = resolveRateLimiter({ ASSETS: { fetch } });
    // Memory path: the first check allows, the second trips the limit.
    expect(await limiter.check("k", 1, 60_000)).toBe(true);
    expect(await limiter.check("k", 1, 60_000)).toBe(false);
  });

  it("routes through the Durable Object binding when present", async () => {
    const fakeNamespace = {
      idFromName: (name: string) => ({ name }),
      get: (_id: { name: string }) => ({
        async check(_limit: number, _windowMs: number): Promise<boolean> {
          return false;
        },
      }),
    };
    const env = {
      ASSETS: { fetch },
      RATE_LIMITER: fakeNamespace,
    } as unknown as WorkerBindings;
    const limiter = resolveRateLimiter(env);
    // The fake stub returns false, proving the DO path (not memory, which
    // would allow the first request).
    expect(await limiter.check("ip:1.2.3.4", 120, 60_000)).toBe(false);
  });
});
