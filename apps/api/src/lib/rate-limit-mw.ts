import { createMemoryRateLimiter, type RateLimiter } from "@app/infra";

const globalLimiter = createMemoryRateLimiter();

export async function allowRequest(
  key: string,
  limiter: RateLimiter = globalLimiter,
  limit = 120,
  windowMs = 60_000,
): Promise<boolean> {
  return limiter.check(key, limit, windowMs);
}
