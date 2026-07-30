export interface ConfigStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export function createMemoryConfigStore(
  initial: Record<string, string> = {},
): ConfigStore {
  const map = new Map(Object.entries(initial));

  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
  };
}
