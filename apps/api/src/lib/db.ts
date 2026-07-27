import type { D1Database, WorkerBindings } from "../env";

export function requireDb(env: WorkerBindings): D1Database {
  if (!env.DB) {
    throw new Error("db_unbound");
  }
  return env.DB;
}
