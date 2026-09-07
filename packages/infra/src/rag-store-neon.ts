import type { RagStore } from "./rag-store";
import type { SqlRunner } from "./rag-store-neon-errors";
import { neonStoreMethods } from "./rag-store-neon-parts";
import {
  DEFAULT_SLOW_QUERY_MS,
  instrumentRunner,
  type NeonRagStoreOptions,
} from "./rag-store-neon-logging";

export type { SqlRunner };

/**
 * The Neon serverless driver's query surface, loosely typed.
 *
 * The adapter only awaits results and validates row shapes itself, so the
 * runner type is intentionally `unknown[]`-shaped rather than generic: this
 * avoids fighting the driver's heavy generics while still letting the real
 * driver query handle be passed directly, and keeps the adapter
 * unit-testable against a fake that returns canned rows. `transaction`
 * mirrors the Neon HTTP driver's non-interactive transaction primitive, used
 * so multi-statement writes (e.g. createSession) are atomic. The type is
 * defined in `rag-store-neon-errors.ts` and re-exported here (the adapter's
 * historical import surface) — see that file for the full rationale.
 */

/**
 * Create a RagStore backed by Neon Postgres + pgvector (ADR-0027 decision 7:
 * the seam is Effect-signatured — every method returns
 * `Effect<A, StoreError>`; driver failures are classified inside the
 * adapter). `sql` is the driver's query object, injected so configuration
 * stays in the caller. Pure composition root: every method delegates to the
 * concern modules (`rag-store-neon-corpus/-eval/-session/-trace/-query/
 * -batch.ts`) — all executable SQL in the repository lives there and in the
 * migrations. Pass `opts.logger` to get slow-query/error ops logging
 * (`rag-store-neon-logging.ts`); omitted, the adapter stays silent.
 */
export function createNeonRagStore(rawSql: SqlRunner, opts: NeonRagStoreOptions = {}): RagStore {
  const logger = opts.logger ?? null;
  const slowQueryMs = opts.slowQueryMs ?? DEFAULT_SLOW_QUERY_MS;
  const sql = logger === null ? rawSql : instrumentRunner(rawSql, logger, slowQueryMs);
  return neonStoreMethods(sql);
}
