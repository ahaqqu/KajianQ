import { describe, expect, it } from "vitest";
import { allowRequest, resolveRateLimiter } from "./resolve-rate-limiter";
import { createMemoryRateLimiter } from "./rate-limiter";

describe("allowRequest", () => {
  it("allows under limit", async () => {
    const limiter = createMemoryRateLimiter();
    expect(await allowRequest("t1", limiter, 5, 60_000)).toBe(true);
  });
});

describe("resolveRateLimiter", () => {
  it("returns a limiter that enforces a per-key window", async () => {
    const limiter = resolveRateLimiter();
    // The first check allows, the second trips the limit — the process-wide
    // limiter counts, rather than resolving to a per-call no-op.
    expect(await limiter.check("resolve-test-key", 1, 60_000)).toBe(true);
    expect(await limiter.check("resolve-test-key", 1, 60_000)).toBe(false);
  });

  it("is a single shared instance across calls (per-process, not per-request)", async () => {
    // Constructing a fresh limiter per request would enforce nothing: the two
    // resolutions below must address the same counter.
    const key = "resolve-shared-key";
    expect(await resolveRateLimiter().check(key, 1, 60_000)).toBe(true);
    expect(await resolveRateLimiter().check(key, 1, 60_000)).toBe(false);
  });
});
