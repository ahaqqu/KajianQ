import { Effect } from "effect";
import { StoreError } from "@app/rag-core";

/**
 * The database driver's query surface, loosely typed.
 *
 * The adapter only awaits results and validates row shapes itself, so the
 * runner type is intentionally `unknown[]`-shaped rather than generic: this
 * avoids fighting the driver's heavy generics while still letting the real
 * driver query handle be passed directly, and keeps the adapter
 * unit-testable against a fake that returns canned rows. `transaction` is a
 * batched primitive — it takes an array of the tagged-template results and
 * runs them atomically — used so multi-statement writes (e.g. `createSession`)
 * cannot half-apply.
 *
 * The tagged-template result is a LAZY thenable in every implementation: the
 * statements handed to `transaction` must not have executed yet, so the
 * batched primitive can run them on one connection inside `BEGIN … COMMIT`
 * (see `rag-store-postgres-driver.ts`). `sqlEffect` documents the contract
 * precisely and is the only consumer that triggers execution.
 *
 * The type lives here — the shared base of the adapter's split modules —
 * and `rag-store-postgres.ts` re-exports it as the adapter's import surface,
 * so external importers are unaffected by the file split.
 */
export type SqlRunner = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  query(text: string, params?: unknown[]): Promise<unknown[]>;
  // `any` here is deliberate: implementations accept an array of their own
  // tagged-template result type, and the adapter only ever passes statements
  // produced by the same runner. A precise signature would force callers into
  // a cast; `any` keeps the already-loose runner assignable.
  transaction(queries: any[]): Promise<any>;
};

/**
 * Vendor-exception → `StoreError` mapping for the Postgres adapter
 * (ADR-0027 decision 7). The taxonomy is closed and this mapper is the ONLY
 * place the driver's exception surface is interpreted — consumers switch on
 * `kind`, never on adapter classes. The classification must be exhaustive
 * over what the driver can throw, with a closed default, so no failure
 * escapes unclassified.
 *
 * The node-postgres (`pg`) driver surfaces:
 * - Server errors: a `pg-protocol` `DatabaseError` carrying the Postgres
 *   error fields — `severity`, `code` (SQLSTATE), `constraint`, `table`. The
 *   parser sets `severity`/`code` explicitly and leaves `name` as the protocol
 *   field ('error'), so `severity` is the marker that identifies this shape.
 *   The shape is read by FIELD, not class identity, so it survives driver
 *   version churn.
 * - Connection-level failures: Node `Error`s (`ECONNREFUSED`, `ENOTFOUND`)
 *   or a `Error: Connection terminated …` from a dropped socket.
 * - `AbortError`/timeout shapes from an aborted operation.
 */

/**
 * SQLSTATE → StoreError kind. Every code the driver can surface for this
 * adapter's operations maps to exactly one kind. Codes absent from this table
 * fall through to the shape rules below — the table holds only the codes whose
 * classification is not derivable from the connection/transport rules.
 */
const SQLSTATE_KINDS: Record<string, "config" | "constraint" | "not_found"> = {
  // Config-class: the store itself is misconfigured.
  "28P01": "config", // invalid_password
  "28000": "config", // insufficient_privilege / bad credentials
  "3D000": "config", // invalid_catalog_name (no such database)
  "08P01": "config", // protocol_violation
  // Config-class: the store itself is misconfigured.
  // Schema-drift codes are config, not constraint: an undefined column/table
  // means the deployed schema does not match the code's expectations — the
  // fix is a migration, not a data change.
  "42703": "config", // undefined_column (schema drifted)
  "42P01": "config", // undefined_table (schema drifted)
  // Constraint-class: deterministic data rejection — fix the data, no retry.
  "23505": "constraint", // unique_violation
  "23503": "constraint", // foreign_key_violation
  "23514": "constraint", // check_violation
  "23502": "constraint", // not_null_violation
  "23510": "constraint", // duplicate_object
  "22001": "constraint", // string_too_long
  "22P02": "constraint", // invalid_text_representation (e.g. bad vector literal)
  "22P03": "constraint", // invalid_binary_representation
  "22003": "constraint", // numeric_value_out_of_range
  "22012": "constraint", // division_by_zero
  "42883": "constraint", // undefined_function
  // Not-found: the requested row does not exist (when null is not the answer).
  P0002: "not_found", // PLpgSQL raise 'not found'
};

/**
 * True when the exception is a Postgres server error by field shape.
 *
 * Deliberately discriminating (ADR-0027 decision 7): SQLSTATE codes are only
 * interpreted on errors that carry a Postgres-server marker — node-postgres
 * sets `severity` on every `pg-protocol` `DatabaseError` (the parser writes it
 * alongside `code`), and no connection-level or Node system error does. Bare
 * `code: string` alone is NOT sufficient — Node system errors
 * (`ErrnoException`, whose `code` is `ECONNREFUSED`/`ENOTFOUND`) and
 * AWS-like exceptions all carry a string `code` that must not reach the
 * SQLSTATE table; those fall through to the closed `transport` default.
 */
function isPostgresDbError(cause: unknown): cause is Error & { code?: string; severity?: unknown } {
  if (!(cause instanceof Error)) return false;
  return "severity" in cause;
}

/**
 * Classify a thrown driver exception into exactly one `StoreError`
 * kind. Order: SQLSTATE table → abort/timeout shapes → field-shape DB
 * errors → closed default `transport`. The original always rides in `cause`.
 */
export function postgresErrorToStoreError(cause: unknown): StoreError {
  // Caller-aborted fetch: the caller (or Effect's interruption channel)
  // cancelled the operation. It maps to the closed default `transport`
  // because the taxonomy has no dedicated `cancelled` kind (ADR-0027
  // decision 7 — a new kind is a seam-contract change requiring an ADR
  // amendment); consumers retrying `transport` may see a rare retry of a
  // cancelled operation, which is harmless (the query is idempotent or
  // guarded by upsert keys). Documented here so the classification is not
  // underdocumented.
  if (cause instanceof Error && cause.name === "AbortError") {
    return new StoreError({ kind: "transport", cause });
  }
  if (cause instanceof Error && /timed?\s?out|deadline|ETIMEDOUT|timeout/i.test(cause.message)) {
    return new StoreError({ kind: "timeout", cause });
  }
  if (isPostgresDbError(cause)) {
    const code = (cause as { code?: string }).code;
    const mapped = code !== undefined ? SQLSTATE_KINDS[code] : undefined;
    if (mapped !== undefined) {
      return new StoreError({ kind: mapped, cause });
    }
    // A driver-level endpoint misconfiguration reported by the server side of
    // the handshake — config, not transport: retrying with the same URL fails
    // identically.
    const message = cause.message;
    if (/connection string|invalid connection|database .* does not exist/i.test(message)) {
      return new StoreError({ kind: "config", cause });
    }
  }
  // Connection-level failures carry a Node errno `code` and no `severity`.
  // A refused connection or an unresolvable host is a wrong host/port/name —
  // config-class, because the same URL fails the same way. Keyed on the errno
  // `code` FIELD, never the message, so an arbitrary `code` (a SQLSTATE, or a
  // non-Postgres system error) cannot reach this branch (the B1 guard).
  const errno = (cause as { code?: unknown } | null)?.code;
  if (errno === "ECONNREFUSED" || errno === "ENOTFOUND") {
    return new StoreError({ kind: "config", cause });
  }
  // Everything else (network blips, dropped sockets, deadlock/serialization
  // SQLSTATEs, unknown shapes): transport — the caller's safest retryable
  // bucket.
  return new StoreError({ kind: "transport", cause });
}

/**
 * Run one SQL operation as an Effect, classified into the `StoreError`
 * taxonomy (ADR-0027 decision 7).
 *
 * Execution-semantics note (driver-coupled, load-bearing): the tagged-template
 * call returns a LAZY thenable whose `.then`/`.catch`/`.finally` each start a
 * fresh execution — it is not a settled promise. The operation must therefore
 * be invoked exactly once, *inside* the `try` factory. Eagerly starting the
 * promise outside, or attaching a second consumer to the lazy promise itself
 * (e.g. `void pending.catch(...)`), executes the same SQL twice CONCURRENTLY:
 * harmless for idempotent upserts, but a plain INSERT with a caller-supplied
 * PK collides with itself (23505) — a silent, order-dependent failure. The
 * same laziness is what lets `transaction` batch un-executed statements.
 *
 * Interruption guard (A1): the fiber's await must not be the ONLY consumer of
 * the in-flight query — if the fiber is interrupted, the rejection would be
 * unobserved. The guard adopts the thenable into a native promise with
 * exactly ONE `execute` call (`Promise.resolve(pending)` invokes `.then`
 * once), then attaches a no-op `catch` to that NATIVE promise — attaching a
 * handler to a native promise never re-executes the query. Both the guard and
 * Effect's await consume the same native promise, so the driver sees exactly
 * one execution per operation, and a mid-flight rejection after interruption
 * is retired without becoming an unhandled rejection.
 */
export function sqlEffect<A>(
  sql: SqlRunner,
  op: (sql: SqlRunner) => Promise<A>,
): Effect.Effect<A, StoreError> {
  return Effect.tryPromise({
    try: () => {
      const pending = op(sql);
      // Adopt the (possibly lazy) driver promise into a native one with
      // exactly one execution, then share it between the guard and the
      // awaiting fiber. `Promise.resolve` on a thenable calls `.then` once —
      // the single execution — and the result is a plain promise: attaching
      // further consumers to it is free.
      const native = Promise.resolve(pending) as Promise<A>;
      native.catch(() => {});
      return native;
    },
    catch: postgresErrorToStoreError,
  });
}
