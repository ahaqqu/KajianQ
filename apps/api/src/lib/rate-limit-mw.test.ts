import { describe, expect, it } from "vitest";
import { createMemoryRateLimiter } from "@app/infra";
import { allowRequest } from "./rate-limit-mw";

describe("allowRequest", () => {
  it("allows under limit", async () => {
    const limiter = createMemoryRateLimiter();
    expect(await allowRequest("t1", limiter, 5, 60_000)).toBe(true);
  });
});
