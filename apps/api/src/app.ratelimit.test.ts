import { describe, expect, it } from "vitest";
import { createApi } from "./app";
import type { WorkerBindings } from "./env";

/**
 * 429 through the real middleware stack. Without a `RATE_LIMITER` binding the
 * middleware falls back to the per-isolate in-memory limiter, so the 120
 * req/min budget in `@app/rate` is intact for this test. The loop
 * drives the limiter to exhaustion instead of mocking it — if the 429 branch
 * in `lib/middleware.ts` is removed, this test fails (no 429 ever arrives).
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

  it("routes through the Durable Object binding when present", async () => {
    const fakeNamespace = {
      idFromName: (name: string) => ({ name }),
      get: (_id: { name: string }) => ({
        async check(_limit: number, _windowMs: number): Promise<boolean> {
          return false;
        },
      }),
    };
    const doEnv = {
      ASSETS: { fetch },
      RATE_LIMITER: fakeNamespace,
    } as unknown as WorkerBindings;
    const api = createApi();
    // The fake stub denies immediately, proving the middleware used the DO
    // path (the in-memory fallback would allow the first request).
    const res = await api.request("/v1/health", {}, doEnv);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });
});
