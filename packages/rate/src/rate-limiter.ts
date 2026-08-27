export interface RateLimiter {
  /** Returns true if allowed, false if limited. */
  check(key: string, limit: number, windowMs: number): Promise<boolean>;
}

export type WindowState = { count: number; start: number };

export type TickResult = {
  count: number;
  start: number;
  allowed: boolean;
  reset: boolean;
};

/**
 * Pure fixed-window tick shared by the in-memory and Durable Object
 * implementations so both backends enforce identical semantics. A window
 * restarts when it is absent or its age reaches `windowMs`; otherwise the
 * count increments and the window keeps its original start.
 */
export function tickFixedWindow(
  cur: WindowState | undefined,
  now: number,
  limit: number,
  windowMs: number,
): TickResult {
  const reset = cur === undefined || now - cur.start >= windowMs;
  const count = reset ? 1 : cur.count + 1;
  const start = reset ? now : cur.start;
  return { count, start, allowed: count <= limit, reset };
}

export type MemoryRateLimiterOptions = {
  /** Upper bound on tracked keys. Defaults to 10_000. */
  maxKeys?: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
};

/**
 * In-memory rate limiter for local dev and as a bindingless fallback.
 * Single-isolate and per-process only — NOT a global defense in production;
 * use `createDurableObjectRateLimiter` (Durable Objects) for cross-isolate
 * enforcement. Bounded to `maxKeys` entries: expired windows are pruned and,
 * when still at capacity, the oldest active window is evicted.
 */
export function createMemoryRateLimiter(
  options: MemoryRateLimiterOptions = {},
): RateLimiter {
  const maxKeys = options.maxKeys ?? 10_000;
  const now = options.now ?? Date.now;
  const map = new Map<string, WindowState>();

  function pruneAndEvict(nowMs: number, windowMs: number): void {
    for (const [key, state] of map) {
      if (nowMs - state.start >= windowMs) map.delete(key);
    }
    if (map.size < maxKeys) return;
    let oldestKey: string | undefined;
    let oldestStart = Number.POSITIVE_INFINITY;
    for (const [key, state] of map) {
      if (state.start < oldestStart) {
        oldestStart = state.start;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) map.delete(oldestKey);
  }

  return {
    async check(key, limit, windowMs) {
      const nowMs = now();
      const cur = map.get(key);
      const result = tickFixedWindow(cur, nowMs, limit, windowMs);
      if (cur === undefined) {
        if (map.size >= maxKeys) pruneAndEvict(nowMs, windowMs);
        map.set(key, { count: result.count, start: result.start });
      } else {
        cur.count = result.count;
        cur.start = result.start;
      }
      return result.allowed;
    },
  };
}

export type RateLimiterStubLike = {
  /** RPC into the Durable Object: atomic check-and-increment. */
  check(limit: number, windowMs: number): Promise<boolean>;
};

/**
 * Rate limiter backed by a Durable Object namespace. The caller supplies a
 * `getStub` factory so this module stays free of Cloudflare-specific types;
 * the Worker composition root maps a key to the Durable Object stub that
 * owns that key's counter.
 */
export function createDurableObjectRateLimiter(
  getStub: (key: string) => RateLimiterStubLike,
): RateLimiter {
  return {
    async check(key, limit, windowMs) {
      return getStub(key).check(limit, windowMs);
    },
  };
}

/**
 * Deterministic 32-bit FNV-1a hex digest. Used to name Durable Objects
 * without persisting raw keys (e.g. client IPs) in object names.
 */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}