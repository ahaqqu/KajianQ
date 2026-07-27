export interface RateLimiter {
  /** Returns true if allowed, false if limited. */
  check(key: string, limit: number, windowMs: number): Promise<boolean>;
}

export function createMemoryRateLimiter(): RateLimiter {
  const map = new Map<string, { count: number; start: number }>();
  return {
    async check(key, limit, windowMs) {
      const now = Date.now();
      const cur = map.get(key);
      if (!cur || now - cur.start >= windowMs) {
        map.set(key, { count: 1, start: now });
        return true;
      }
      if (cur.count >= limit) return false;
      cur.count += 1;
      return true;
    },
  };
}
