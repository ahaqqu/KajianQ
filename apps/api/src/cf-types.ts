/** Minimal CF types so root tsc works without global workers types. */
export type D1PreparedStatement = {
  bind(...args: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
};

export type D1Database = {
  prepare(query: string): D1PreparedStatement;
};

export type R2Bucket = {
  put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<unknown>;
  list(opts?: { prefix?: string }): Promise<{ objects: { key: string }[] }>;
};
