import { describe, expect, it } from "vitest";
import { createMemoryConfigStore } from "./config-store";
import { createMemoryRateLimiter } from "./rate-limit";

describe("infra adapters", () => {
  it("config store", async () => {
    const cfg = createMemoryConfigStore({ a: "1" });
    expect(await cfg.get("a")).toBe("1");
    await cfg.set("b", "2");
    expect(await cfg.get("b")).toBe("2");
  });

  it("rate limiter", async () => {
    const r = createMemoryRateLimiter();
    expect(await r.check("k", 2, 60_000)).toBe(true);
    expect(await r.check("k", 2, 60_000)).toBe(true);
    expect(await r.check("k", 2, 60_000)).toBe(false);
  });
});
