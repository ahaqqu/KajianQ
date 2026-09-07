import { Effect } from "effect";
import { StoreError } from "@app/rag-core";

/**
 * The Neon serverless driver's query surface, loosely typed.
 *
 * The adapter only awaits results and validates row shapes itself, so the
 * runner type is intentionally `unknown[]`-shaped rather than generic: this
 * avoids fighting the driver's heavy generics while still letting the real
 * driver query handle be passed directly, and keeps the adapter
 * unit-testable against a fake that returns canned rows. `transaction`
 * mirrors the Neon HTTP driver's non-interactive transaction primitive, used
 * so multi-statement writes (e.g. createSession) are atomic.
 *
 * The type lives here — the shared base of the adapter's split modules —
 * and `rag-store-neon.ts` re-exports it as the adapter's historical import
 * surface, so external importers are unaffected by the file split.
 */
export type SqlRunner = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  query(text: string, params?: unknown[]): Promise<unknown[]>;
  // `any` here is deliberate: the Neon HTTP driver's `transaction()` accepts
  // a union of an array of its own query-promise type OR a callback, and the
  // adapter only ever passes an array of the call-signature's `Promise<unknown[]>`.
  // A precise signature would force callers into a cast; `any` keeps the
  // already-loose runner assignable from the real driver handle.
  transaction(queries: any[]): Promise<any>;
};

/**
 * Vendor-exception → `StoreError` mapping for the Neon adapter
 * (ADR-0027 decision 7). The taxonomy is closed and this mapper is the ONLY
 * place Neon's exception surface is interpreted — consumers switch on
 * `kind`, never on adapter classes. The classification must be exhaustive
 * over what the Neon HTTP driver can throw, with a closed default, so no
 * failure escapes unclassified.
 *
 * The Neon serverless driver surfaces:
 * - `NeonDbError` (HTTP-driver path): carries Postgres error fields —
 *   `code` (SQLSTATE), `severity`, `constraint`, `table`.
 * - `DatabaseError` (WebSocket path; the driver re-exports the
 *   node-postgres error shape): same `code`/`constraint` fields.
 *   PostgresError is the name users know for that shape; both are handled
 *   here by field shape, not by class identity, so the mapping survives
 *   driver version churn.
 * - Network-level `TypeError`/`DOMException` from the underlying `fetch`
 *   (transport/abort).
 */

/**
 * SQLSTATE → StoreError kind. Every code the Neon HTTP driver can surface
 * for this adapter's operations maps to exactly one kind. Codes absent from
 * this table fall through to the class-shape rules below — the table holds
 * only the codes whose classification is not derivable from the HTTP status
 * or shape rules.
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
 * True when the exception is a Neon/Postgres DB error by field shape.
 *
 * Deliberately discriminating (ADR-0027 decision 7): SQLSTATE codes are
 * only interpreted on errors that carry a Neon/Postgres-specific marker —
 * the driver's `NeonDbError`/`DatabaseError` name, or a `severity` field
 * (both driver paths set it; no non-Postgres exception does). Bare
 * `code: string` alone is NOT sufficient — Node system errors
 * (`ErrnoException`), fetch failures, and AWS-like exceptions all carry a
 * string `code` that must not reach the SQLSTATE table; those fall through
 * to the closed `transport` default.
 */
function isNeonDbError(cause: unknown): cause is Error & { code?: string; name?: string } {
  if (!(cause instanceof Error)) return false;
  const named = cause as { name?: string; code?: unknown; severity?: unknown };
  const driverNamed = named.name === "NeonDbError" || named.name === "DatabaseError";
  return driverNamed && (typeof named.code === "string" || "severity" in named);
}

/**
 * Classify a thrown Neon driver exception into exactly one `StoreError`
 * kind. Order: SQLSTATE table → abort/timeout shapes → field-shape DB
 * errors → closed default `transport`. The original always rides in `cause`.
 */
export function neonErrorToStoreError(cause: unknown): StoreError {
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
  if (isNeonDbError(cause)) {
    const code = (cause as { code?: string }).code;
    const mapped = code !== undefined ? SQLSTATE_KINDS[code] : undefined;
    if (mapped !== undefined) {
      return new StoreError({ kind: mapped, cause });
    }
    // A driver-level auth/endpoint misconfiguration (e.g. fetch returned a
    // non-2xx before any SQL ran: bad connection string) — config, not
    // transport: retrying with the same URL fails identically.
    const message = cause.message;
    if (
      /fetch returned|connection string|invalid connection|ECONNREFUSED|ENOTFOUND/i.test(message)
    ) {
      return new StoreError({ kind: "config", cause });
    }
  }
  // Everything else (network blips, HTTP 5xx from the driver, unknown
  // shapes): transport — the caller's safest retryable bucket.
  return new StoreError({ kind: "transport", cause });
}

/**
 * Run one SQL operation as an Effect, classified into the `StoreError`
 * taxonomy (ADR-0027 decision 7).
 *
 * Execution-semantics note (driver-coupled, load-bearing): the Neon HTTP
 * driver's query function returns a LAZY query promise (NeonQueryPromise) whose
 * `.then`/`.catch`/`.finally` each fire a fresh HTTP query — it is not a
 * settled promise. The operation must therefore be invoked exactly once,
 * *inside* the `try` factory. Eagerly starting the promise outside, or
 * attaching a second consumer to the lazy promise itself (e.g.
 * `void pending.catch(...)`), executes the same SQL twice CONCURRENTLY:
 * harmless for idempotent upserts, but a plain INSERT with a caller-supplied
 * PK collides with itself (23505) — a silent, order-dependent failure.
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
    catch: neonErrorToStoreError,
  });
}
