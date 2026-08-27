import { describe, expect, it, vi } from "vitest";
import {
  createDurableObjectRateLimiter,
  createMemoryRateLimiter,
  fnv1aHex,
  tickFixedWindow,
} from "./rate-limit";

describe("tickFixedWindow", () => {
  it("starts a fresh window", () => {
    expect(tickFixedWindow(undefined, 100, 5, 60_000)).toEqual({
      count: 1,
      start: 100,
      allowed: true,
      reset: true,
    });
  });

  it("increments within the window", () => {
    expect(tickFixedWindow({ count: 2, start: 100 }, 150, 5, 60_000)).toEqual({
      count: 3,
      start: 100,
      allowed: true,
      reset: false,
    });
  });

  it("denies once the count exceeds the limit", () => {
    expect(tickFixedWindow({ count: 5, start: 100 }, 150, 5, 60_000)).toEqual({
      count: 6,
      start: 100,
      allowed: false,
      reset: false,
    });
  });

  it("resets once the window lapses", () => {
    expect(tickFixedWindow({ count: 3, start: 100 }, 100 + 60_000, 5, 60_000)).toEqual({
      count: 1,
      start: 100 + 60_000,
      allowed: true,
      reset: true,
    });
  });
});

describe("createMemoryRateLimiter", () => {
  it("allows then denies within a window", async () => {
    const limiter = createMemoryRateLimiter();
    expect(await limiter.check("k", 2, 60_000)).toBe(true);
    expect(await limiter.check("k", 2, 60_000)).toBe(true);
    expect(await limiter.check("k", 2, 60_000)).toBe(false);
  });

  it("resets after the window lapses", async () => {
    let t = 0;
    const limiter = createMemoryRateLimiter({ now: () => t });
    expect(await limiter.check("k", 2, 60_000)).toBe(true);
    expect(await limiter.check("k", 2, 60_000)).toBe(true);
    expect(await limiter.check("k", 2, 60_000)).toBe(false);
    t = 60_000;
    expect(await limiter.check("k", 2, 60_000)).toBe(true);
  });

  it("evicts the oldest key when at capacity", async () => {
    const limiter = createMemoryRateLimiter({ maxKeys: 2, now: () => 1_000 });
    expect(await limiter.check("a", 1, 60_000)).toBe(true);
    expect(await limiter.check("a", 1, 60_000)).toBe(false); // a at limit
    expect(await limiter.check("b", 1, 60_000)).toBe(true);
    // Inserting "c" at capacity evicts the oldest active key ("a").
    expect(await limiter.check("c", 1, 60_000)).toBe(true);
    // "a" was evicted, so it starts a fresh window.
    expect(await limiter.check("a", 1, 60_000)).toBe(true);
  });
});

describe("createDurableObjectRateLimiter", () => {
  it("delegates to the stub for the key", async () => {
    const calls: { limit: number; windowMs: number }[] = [];
    const stub = {
      async check(limit: number, windowMs: number): Promise<boolean> {
        calls.push({ limit, windowMs });
        return false;
      },
    };
    const getStub = vi.fn((_key: string) => stub);
    const limiter = createDurableObjectRateLimiter(getStub);
    expect(await limiter.check("ip:1.2.3.4", 120, 60_000)).toBe(false);
    expect(getStub).toHaveBeenCalledWith("ip:1.2.3.4");
    expect(calls).toEqual([{ limit: 120, windowMs: 60_000 }]);
  });
});

describe("fnv1aHex", () => {
  it("is deterministic and fixed-width", () => {
    expect(fnv1aHex("ip:1.2.3.4")).toBe(fnv1aHex("ip:1.2.3.4"));
    expect(fnv1aHex("ip:1.2.3.4")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("distinguishes different keys", () => {
    expect(fnv1aHex("ip:1.2.3.4")).not.toBe(fnv1aHex("ip:1.2.3.5"));
  });
});
