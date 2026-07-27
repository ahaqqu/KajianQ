export interface ConfigStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  hasEntitlement(userId: string, feature: string): Promise<boolean>;
}

export function createMemoryConfigStore(
  initial: Record<string, string> = {},
): ConfigStore {
  const map = new Map(Object.entries(initial));
  const entitlements = new Set<string>();

  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async hasEntitlement(userId, feature) {
      return entitlements.has(`${userId}:${feature}`) || map.get(`entitlement:${feature}`) === "on";
    },
  };
}
