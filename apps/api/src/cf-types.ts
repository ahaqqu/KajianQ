/** Minimal CF types so root tsc works without global workers types. */
import type { R2Like } from "@app/infra";

export type D1PreparedStatement = {
  bind(...args: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
};

export type D1Database = {
  prepare(query: string): D1PreparedStatement;
};

/** Canonical R2 bucket shape lives in @app/infra (object-store adapter). */
export type R2Bucket = R2Like;
