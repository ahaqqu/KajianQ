import { describe, expect, it } from "vitest";
import { createMemoryRateLimiter, type RateLimiterNamespace } from "@app/rate";
import { createApi } from "./app";
import type { WorkerBindings } from "./env";

/**
 * 429 through the real middleware stack, without coupling to the module-level
 * global limiter or the production 120/min constant. A fresh, isolated
 * `RateLimiter` is injected via `createApi` so the test neither depends on
 * vitest module isolation nor exhausts a shared budget; `limit` is set to a
 * small value so the 429 branch is reached in a handful of requests. If the
 * 429 branch in `lib/middleware.ts` is removed, this test fails (no 429 ever
 * arrives).
 */
const env = { ASSETS: { fetch } };
const limit = 3;

describe("rate limiting", () => {
  it("allows the first N requests then returns 429 rate_limited", async () => {
    const api = createApi({ limiter: createMemoryRateLimiter(), limit });
    for (let i = 0; i < limit; i += 1) {
      const res = await api.request("/v1/health", {}, env);
      expect(res.status).toBe(200);
    }
    const res = await api.request("/v1/health", {}, env);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    // Correlation ids are set before the rate-limit short-circuit.
    expect(res.headers.get("X-Correlation-Id")).toBeTruthy();
  });

  it("resolves the Durable Object backend from the binding when no limiter is injected", async () => {
    const fakeNamespace: RateLimiterNamespace = {
      idFromName: (name: string) => ({ name }),
      get: (_id: unknown) => ({
        async check(_limit: number, _windowMs: number): Promise<boolean> {
          return false;
        },
      }),
    };
    const doEnv = {
      ASSETS: { fetch },
      RATE_LIMITER: fakeNamespace,
    } as unknown as WorkerBindings;
    // No injected limiter: middleware resolves from bindings. The fake stub
    // denies immediately, proving the DO path (the in-memory fallback would
    // allow the first request).
    const api = createApi();
    const res = await api.request("/v1/health", {}, doEnv);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });
});