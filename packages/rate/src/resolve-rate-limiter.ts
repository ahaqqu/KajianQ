import {
  createDurableObjectRateLimiter,
  createMemoryRateLimiter,
  fnv1aHex,
  type RateLimiter,
  type RateLimiterStubLike,
} from "./rate-limiter";

/**
 * Minimal Durable Object namespace shape, structurally compatible with the
 * Workers runtime binding. Keeping it here lets `resolveRateLimiter` select
 * backends without importing app-level or runtime-specific types.
 */
export type RateLimiterNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): RateLimiterStubLike;
};

/**
 * Bindingless fallback for local dev and tests. Per-isolate and bounded; the
 * global defense in production is the Durable Object implementation selected
 * by `resolveRateLimiter`.
 */
const memoryLimiter = createMemoryRateLimiter();

/**
 * Resolves the rate limiter for a Worker: Durable Objects when the
 * `RATE_LIMITER` binding is present (global across isolates and POPs), else
 * the in-memory fallback. Accepts any env structurally — the Worker
 * composition root passes its full bindings object.
 */
export function resolveRateLimiter(env: {
  RATE_LIMITER?: RateLimiterNamespace;
}): RateLimiter {
  const namespace = env.RATE_LIMITER;
  if (namespace) {
    return createDurableObjectRateLimiter((key) =>
      namespace.get(namespace.idFromName(fnv1aHex(key))),
    );
  }
  return memoryLimiter;
}

/**
 * Default edge policy: 120 requests per minute per key. Callers may override
 * per invocation; the middleware seam stays identical across backends.
 */
export async function allowRequest(
  key: string,
  limiter: RateLimiter,
  limit = 120,
  windowMs = 60_000,
): Promise<boolean> {
  return limiter.check(key, limit, windowMs);
}