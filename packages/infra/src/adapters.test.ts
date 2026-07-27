import { describe, expect, it, vi } from "vitest";
import { createMemoryCache } from "./cache";
import { createMemoryConfigStore } from "./config-store";
import { createJobScheduler } from "./job-scheduler";
import { createMemoryRateLimiter } from "./rate-limit";
import { createSentry } from "./sentry";

describe("infra adapters", () => {
  it("cache ttl", async () => {
    const c = createMemoryCache();
    await c.set("k", "v", 1);
    expect(await c.get("k")).toBe("v");
    await c.delete("k");
    expect(await c.get("k")).toBeNull();
  });

  it("config store", async () => {
    const cfg = createMemoryConfigStore({ a: "1" });
    expect(await cfg.get("a")).toBe("1");
    await cfg.set("b", "2");
    expect(await cfg.get("b")).toBe("2");
    expect(await cfg.hasEntitlement("u", "pro")).toBe(false);
  });

  it("job scheduler", async () => {
    const j = createJobScheduler();
    const fn = vi.fn();
    j.register("t", fn);
    await j.run("t");
    expect(fn).toHaveBeenCalledOnce();
    await expect(j.run("missing")).rejects.toThrow("job_missing");
  });

  it("rate limiter", async () => {
    const r = createMemoryRateLimiter();
    expect(await r.check("k", 2, 60_000)).toBe(true);
    expect(await r.check("k", 2, 60_000)).toBe(true);
    expect(await r.check("k", 2, 60_000)).toBe(false);
  });

  it("sentry no-op without dsn", () => {
    const s = createSentry(undefined);
    expect(() => s.captureException(new Error("x"))).not.toThrow();
    expect(() => s.captureMessage("m")).not.toThrow();
  });

  it("sentry with dsn logs", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const s = createSentry("https://example.com/1");
    s.captureException("e");
    s.captureMessage("m");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
