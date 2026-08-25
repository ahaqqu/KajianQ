import { createMemoryRateLimiter, type RateLimiter } from "@app/infra";

export type { RateLimiter };

/**
 * Module-level limiter shared by every request handled by this isolate.
 *
 * The default backend is in-memory and therefore best-effort: no shared state
 * across Worker isolates or POPs, counters reset on cold starts, and tracked
 * keys are capped (`maxKeys`, see packages/infra/src/rate-limit.ts) so key
 * churn cannot exhaust isolate memory. See docs/ARCHITECTURE.md ("Rate
 * limiter limitations"); a hard global guarantee needs a shared-backend
 * `RateLimiter` adapter injected here instead. Tests inject isolated
 * limiters via `createApi({ limiter })`.
 */
const globalLimiter = createMemoryRateLimiter();

export async function allowRequest(
  key: string,
  limiter: RateLimiter = globalLimiter,
  limit = 120,
  windowMs = 60_000,
): Promise<boolean> {
  return limiter.check(key, limit, windowMs);
}
