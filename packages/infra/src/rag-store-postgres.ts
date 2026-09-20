import type { RagStore } from "./rag-store";
import type { SqlRunner } from "./rag-store-postgres-errors";
import { postgresStoreMethods } from "./rag-store-postgres-parts";
import {
  DEFAULT_SLOW_QUERY_MS,
  instrumentRunner,
  type PostgresRagStoreOptions,
} from "./rag-store-postgres-logging";

export type { SqlRunner };

/**
 * The database driver's query surface, loosely typed.
 *
 * The adapter only awaits results and validates row shapes itself, so the
 * runner type is intentionally `unknown[]`-shaped rather than generic: this
 * avoids fighting the driver's heavy generics while still letting the real
 * driver query handle be passed directly, and keeps the adapter
 * unit-testable against a fake that returns canned rows. `transaction` is a
 * batched primitive — it takes an array of not-yet-executed tagged-template
 * statements and runs them atomically — used so multi-statement writes (e.g.
 * `createSession`) cannot half-apply. The type is defined in
 * `rag-store-postgres-errors.ts` and re-exported here (the adapter's import
 * surface) — see that file for the full rationale.
 */

/**
 * Create a RagStore backed by Postgres + pgvector (ADR-0027 decision 7: the
 * seam is Effect-signatured — every method returns `Effect<A, StoreError>`;
 * driver failures are classified inside the adapter). `sql` is the driver's
 * query object, injected so configuration stays in the caller; the `pg` driver
 * itself is adapted in `rag-store-postgres-driver.ts`, and Post-cutover the
 * server is the self-hosted one on the netcup VPS (ADR-0044). Pure composition
 * root: every method delegates to the concern modules
 * (`rag-store-postgres-corpus/-eval/-session/-trace/-query/-batch.ts`) — all
 * executable SQL in the repository lives there and in the migrations. Pass
 * `opts.logger` to get slow-query/error ops logging
 * (`rag-store-postgres-logging.ts`); omitted, the adapter stays silent.
 */
export function createPostgresRagStore(
  rawSql: SqlRunner,
  opts: PostgresRagStoreOptions = {},
): RagStore {
  const logger = opts.logger ?? null;
  const slowQueryMs = opts.slowQueryMs ?? DEFAULT_SLOW_QUERY_MS;
  const sql = logger === null ? rawSql : instrumentRunner(rawSql, logger, slowQueryMs);
  return postgresStoreMethods(sql);
}
