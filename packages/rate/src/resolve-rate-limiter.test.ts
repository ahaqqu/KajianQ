import { describe, expect, it } from "vitest";
import type { RateLimiterNamespace } from "./resolve-rate-limiter";
import { allowRequest, resolveRateLimiter } from "./resolve-rate-limiter";
import { createMemoryRateLimiter } from "./rate-limiter";

describe("allowRequest", () => {
  it("allows under limit", async () => {
    const limiter = createMemoryRateLimiter();
    expect(await allowRequest("t1", limiter, 5, 60_000)).toBe(true);
  });
});

describe("resolveRateLimiter", () => {
  it("uses the in-memory fallback without a binding", async () => {
    const limiter = resolveRateLimiter({});
    // Memory path: the first check allows, the second trips the limit.
    expect(await limiter.check("k", 1, 60_000)).toBe(true);
    expect(await limiter.check("k", 1, 60_000)).toBe(false);
  });

  it("routes through the Durable Object binding when present", async () => {
    const fakeNamespace: RateLimiterNamespace = {
      idFromName: (name: string) => ({ name }),
      get: (_id: unknown) => ({
        async check(_limit: number, _windowMs: number): Promise<boolean> {
          return false;
        },
      }),
    };
    const limiter = resolveRateLimiter({ RATE_LIMITER: fakeNamespace });
    // The fake stub returns false, proving the DO path (not memory, which
    // would allow the first request).
    expect(await limiter.check("ip:1.2.3.4", 120, 60_000)).toBe(false);
  });
});