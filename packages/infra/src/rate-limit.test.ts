import { describe, expect, it } from "vitest";
import {
  createMemoryRateLimiter,
  type MemoryRateLimiterOptions,
} from "./rate-limit";

/** Deterministic manual clock so window boundaries are exact. */
function makeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function makeLimiter(options?: MemoryRateLimiterOptions) {
  const clock = makeClock();
  return { clock, limiter: createMemoryRateLimiter({ now: clock.now, ...options }) };
}

describe("createMemoryRateLimiter", () => {
  it("allows requests under the limit within the window", async () => {
    const { limiter } = makeLimiter();
    expect(await limiter.check("k", 3, 60_000)).toBe(true);
    expect(await limiter.check("k", 3, 60_000)).toBe(true);
    expect(await limiter.check("k", 3, 60_000)).toBe(true);
  });

  it("blocks at the limit until the window expires", async () => {
    const { clock, limiter } = makeLimiter();
    expect(await limiter.check("k", 2, 1_000)).toBe(true);
    expect(await limiter.check("k", 2, 1_000)).toBe(true);
    expect(await limiter.check("k", 2, 1_000)).toBe(false);
    clock.advance(999);
    expect(await limiter.check("k", 2, 1_000)).toBe(false);
    clock.advance(1); // t = window end -> fresh budget
    expect(await limiter.check("k", 2, 1_000)).toBe(true);
    expect(await limiter.check("k", 2, 1_000)).toBe(true);
    expect(await limiter.check("k", 2, 1_000)).toBe(false);
  });

  it("tracks keys independently", async () => {
    const { limiter } = makeLimiter();
    expect(await limiter.check("a", 1, 60_000)).toBe(true);
    expect(await limiter.check("b", 1, 60_000)).toBe(true);
    expect(await limiter.check("a", 1, 60_000)).toBe(false);
    expect(await limiter.check("b", 1, 60_000)).toBe(false);
  });

  it("prunes expired windows before touching live keys at capacity", async () => {
    const { clock, limiter } = makeLimiter({ maxKeys: 2 });
    // k1 expires at t=1000; k2 at t=2000 and is exhausted (count = limit).
    await limiter.check("k1", 1, 1000);
    expect(await limiter.check("k2", 2, 2000)).toBe(true);
    expect(await limiter.check("k2", 2, 2000)).toBe(true);
    clock.advance(1100); // k1 expired; k2 still live.
    // Inserting k3 at capacity must reclaim the expired k1, not evict live k2.
    expect(await limiter.check("k3", 1, 1000)).toBe(true);
    // k2 kept its exhausted counter (a fresh key would be allowed here).
    expect(await limiter.check("k2", 2, 2000)).toBe(false);
    expect(await limiter.check("k1", 1, 1000)).toBe(true);
  });

  it("evicts the oldest-inserted key as a fallback when nothing has expired", async () => {
    const { limiter } = makeLimiter({ maxKeys: 2 });
    await limiter.check("a", 1, 60_000);
    await limiter.check("b", 1, 60_000);
    expect(await limiter.check("c", 1, 60_000)).toBe(true); // evicts "a"
    // "b" survived with its state intact.
    expect(await limiter.check("b", 1, 60_000)).toBe(false);
    // "a" was evicted and gets a brand-new budget.
    expect(await limiter.check("a", 1, 60_000)).toBe(true);
    expect(await limiter.check("a", 1, 60_000)).toBe(false);
  });

  it("moves a key whose window resets to the back of the eviction order", async () => {
    const { clock, limiter } = makeLimiter({ maxKeys: 2 });
    await limiter.check("short", 1, 1_000); // expires at t=1000
    await limiter.check("long", 1, 120_000); // expires at t=120000
    clock.advance(1100);
    // Resetting "short" re-inserts it after "long".
    expect(await limiter.check("short", 1, 1_000)).toBe(true);
    // Capacity pressure now evicts "long" even though its window is still open.
    expect(await limiter.check("newcomer", 1, 60_000)).toBe(true);
    expect(await limiter.check("long", 1, 120_000)).toBe(true); // fresh budget
    expect(await limiter.check("long", 1, 120_000)).toBe(false);
  });

  it("bounds tracked memory under sustained key churn", async () => {
    const limiter = createMemoryRateLimiter({ maxKeys: 50 });
    for (let i = 0; i < 500; i += 1) {
      await limiter.check(`key-${i}`, 1, 60_000);
    }
    // Early keys were evicted long ago: they get fresh budgets.
    expect(await limiter.check("key-0", 1, 60_000)).toBe(true);
    expect(await limiter.check("key-0", 1, 60_000)).toBe(false);
  });

  it("works with the real clock and default options", async () => {
    const limiter = createMemoryRateLimiter();
    expect(await limiter.check("x", 2, 60_000)).toBe(true);
    expect(await limiter.check("x", 2, 60_000)).toBe(true);
    expect(await limiter.check("x", 2, 60_000)).toBe(false);
  });
});
