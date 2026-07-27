export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createMemoryCache(): Cache {
  const map = new Map<string, { value: string; exp?: number }>();
  return {
    async get(key) {
      const e = map.get(key);
      if (!e) return null;
      if (e.exp !== undefined && Date.now() > e.exp) {
        map.delete(key);
        return null;
      }
      return e.value;
    },
    async set(key, value, ttlSeconds) {
      map.set(key, {
        value,
        ...(ttlSeconds
          ? { exp: Date.now() + ttlSeconds * 1000 }
          : {}),
      });
    },
    async delete(key) {
      map.delete(key);
    },
  };
}
