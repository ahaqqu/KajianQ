import { createMemoryRateLimiter, type RateLimiter } from "./rate-limiter";

/**
 * The process-wide limiter (#181, ADR-0044). A bounded in-memory backend is
 * the right shape self-hosted: the API runs as ONE process behind the reverse
 * proxy, so "per-process" and "global" are the same set — the property Durable
 * Objects existed to provide (cross-isolate, cross-POP counting) has no meaning
 * when there is exactly one isolate.
 *
 * What changed with the move is therefore the mechanism, not the guarantee:
 * the counter is still global for the deployment, and it is still created once
 * per process rather than per request (a per-request map would enforce
 * nothing). What is genuinely lost is protection against a future scale-out to
 * several API processes; the revisit trigger is recorded in ADR-0044, and the
 * bounded map's eviction (pruning expired windows, then the oldest) is what
 * keeps memory flat.
 *
 * The key is hashed before it reaches this map (`fnv1aHex`, in the middleware
 * seam) so the limiter holds no raw IP address — the retention notice says
 * "kept in memory and named by a digest", and that must stay true.
 */
const memoryLimiter = createMemoryRateLimiter();

/**
 * Resolve the process-wide limiter. A function rather than a bare constant so
 * the export stays an indirection point if a second backend ever returns (the
 * shared-counter revisit trigger in ADR-0044: a scale-out to several API
 * processes would need one) — callers swap the backend here, not at every
 * call site. It takes no arguments and passes no bindings; the one real
 * invariant, a single shared instance per process, is what the tests pin.
 */
export function resolveRateLimiter(): RateLimiter {
  return memoryLimiter;
}

/**
 * Default policy: 120 requests per minute per key. Callers may override per
 * invocation; the middleware seam is unchanged.
 */
export async function allowRequest(
  key: string,
  limiter: RateLimiter,
  limit = 120,
  windowMs = 60_000,
): Promise<boolean> {
  return limiter.check(key, limit, windowMs);
}
