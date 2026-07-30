import { describe, expect, it } from "vitest";
import { createApi } from "./app";

/**
 * 429 through the real middleware stack: a fresh module graph per test file
 * means a fresh global rate limiter, so the 120 req/min budget in
 * `rate-limit-mw.ts` is intact here. The loop drives the limiter to
 * exhaustion instead of mocking it — if the 429 branch in
 * `lib/middleware.ts` is removed, this test fails (no 429 ever arrives).
 * Coupled to the 120/min constant by design: change the limit, update this.
 */
const env = { ASSETS: { fetch } };

describe("rate limiting", () => {
  it("allows 120 requests then returns 429 rate_limited", async () => {
    const api = createApi();
    for (let i = 0; i < 120; i += 1) {
      const res = await api.request("/v1/health", {}, env);
      expect(res.status).toBe(200);
    }
    const res = await api.request("/v1/health", {}, env);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    // Correlation ids are set before the rate-limit short-circuit.
    expect(res.headers.get("X-Correlation-Id")).toBeTruthy();
  });
});
