/**
 * In-memory, single-isolate rate limiter. Best-effort only:
 *
 * - Each Worker isolate keeps its own counters; state is not shared across
 *   isolates or POPs and resets on cold starts (see docs/ARCHITECTURE.md,
 *   "Rate limiter limitations").
 * - Memory is bounded: when the map is full, expired windows are pruned
 *   first, then the oldest-inserted key is evicted, so unbounded key churn
 *   (e.g. rotated source IPs) cannot exhaust isolate memory.
 * - A hard, global guarantee requires a shared-backend implementation of the
 *   same `RateLimiter` interface (e.g. Durable Objects / KV adapter behind
 *   `packages/infra`); this module stays the local fallback.
 */
export interface RateLimiter {
  /** Returns true if allowed, false if limited. */
  check(key: string, limit: number, windowMs: number): Promise<boolean>;
}

export interface MemoryRateLimiterOptions {
  /**
   * Maximum number of distinct keys tracked before pruning/eviction kicks
   * in. The default keeps worst-case memory well inside a Worker isolate's
   * budget (~1-2 MB).
   */
  maxKeys?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_MAX_KEYS = 10_000;

interface WindowCounter {
  count: number;
  start: number;
  expiresAt: number;
}

export function createMemoryRateLimiter(
  options: MemoryRateLimiterOptions = {},
): RateLimiter {
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const now = options.now ?? Date.now;
  // Map preserves insertion order, which gives cheap FIFO eviction; keys
  // whose window resets are re-inserted, moving them to the back so active
  // keys are evicted last.
  const windows = new Map<string, WindowCounter>();

  const pruneExpired = (t: number): void => {
    for (const [key, counter] of windows) {
      if (counter.expiresAt <= t) {
        windows.delete(key);
      }
    }
  };

  return {
    async check(key, limit, windowMs) {
      const t = now();
      const cur = windows.get(key);
      if (!cur || cur.expiresAt <= t) {
        if (!cur && windows.size >= maxKeys) {
          pruneExpired(t);
          if (windows.size >= maxKeys) {
            const oldest = windows.keys().next();
            if (!oldest.done) windows.delete(oldest.value);
          }
        }
        windows.delete(key);
        windows.set(key, { count: 1, start: t, expiresAt: t + windowMs });
        return true;
      }
      if (cur.count >= limit) return false;
      cur.count += 1;
      return true;
    },
  };
}
