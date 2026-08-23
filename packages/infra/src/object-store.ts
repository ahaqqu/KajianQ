export interface ObjectStore {
  put(key: string, value: Uint8Array | string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export function createMemoryObjectStore(): ObjectStore {
  const map = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const toBytes = (v: Uint8Array | string) =>
    typeof v === "string" ? enc.encode(v) : v;

  return {
    async put(key, value) {
      map.set(key, toBytes(value));
    },
    async get(key) {
      return map.get(key) ?? null;
    },
    async delete(key) {
      map.delete(key);
    },
    async list(prefix = "") {
      return [...map.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

export type R2Like = {
  put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<unknown>;
  list(opts?: { prefix?: string }): Promise<{ objects: { key: string }[] }>;
};

export function createR2ObjectStore(bucket: R2Like): ObjectStore {
  return {
    async put(key, value) {
      await bucket.put(key, value);
    },
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async list(prefix = "") {
      const res = await bucket.list({ prefix });
      return res.objects.map((o) => o.key);
    },
  };
}
