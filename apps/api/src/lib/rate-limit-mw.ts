import {
  createDurableObjectRateLimiter,
  createMemoryRateLimiter,
  fnv1aHex,
  type RateLimiter,
} from "@app/infra";
import type { WorkerBindings } from "../env";

/**
 * Bindingless fallback for local dev and tests. Per-isolate and bounded; the
 * global defense in production is the Durable Object implementation selected
 * by `resolveRateLimiter`.
 */
const memoryLimiter = createMemoryRateLimiter();

/**
 * Resolves the rate limiter for this Worker: Durable Objects when the
 * `RATE_LIMITER` binding is present (global across isolates and POPs), else
 * the in-memory fallback.
 */
export function resolveRateLimiter(env: WorkerBindings): RateLimiter {
  const namespace = env.RATE_LIMITER;
  if (namespace) {
    return createDurableObjectRateLimiter((key) =>
      namespace.get(namespace.idFromName(fnv1aHex(key))),
    );
  }
  return memoryLimiter;
}

export async function allowRequest(
  key: string,
  limiter: RateLimiter,
  limit = 120,
  windowMs = 60_000,
): Promise<boolean> {
  return limiter.check(key, limit, windowMs);
}
