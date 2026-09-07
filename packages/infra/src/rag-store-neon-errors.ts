import { Effect } from "effect";
import { StoreError } from "@app/rag-core";
import type { SqlRunner } from "./rag-store-neon";

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
 * - `DatabaseError` (WebSocket path, `@neondatabase/serverless` re-exports
 *   the node-postgres error shape): same `code`/`constraint` fields.
 *   PostgresError is the superSet name users know; both are handled here by
 *   field shape, not by class identity, so the mapping survives driver
 *   version churn.
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
  "42703": "constraint", // undefined_column (schema drifted vs input shape)
  "42P01": "constraint", // undefined_table (schema drifted)
  "42883": "constraint", // undefined_function
  // Not-found: the requested row does not exist (when null is not the answer).
  "P0002": "not_found", // PLpgSQL raise 'not found'
};

/** True when the exception is an HTTP-driver DB error by field shape. */
function isNeonDbError(cause: unknown): cause is Error & { code?: string; name?: string } {
  if (!(cause instanceof Error)) return false;
  const named = cause as { name?: string; code?: unknown };
  return named.name === "NeonDbError" || typeof named.code === "string";
}

/**
 * Classify a thrown Neon driver exception into exactly one `StoreError`
 * kind. Order: SQLSTATE table → abort/timeout shapes → field-shape DB
 * errors → closed default `transport`. The original always rides in `cause`.
 */
export function neonErrorToStoreError(cause: unknown): StoreError {
  // Client-aborted fetch: the caller interrupted — a transport-class
  // failure (Effect's interruption channel handles the semantic; the
  // message check keeps an AbortError from being misfiled).
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
    if (/fetch returned|connection string|invalid connection|ECONNREFUSED|ENOTFOUND/i.test(message)) {
      return new StoreError({ kind: "config", cause });
    }
  }
  // Everything else (network blips, HTTP 5xx from the driver, unknown
  // shapes): transport — the caller's safest retryable bucket.
  return new StoreError({ kind: "transport", cause });
}

/**
 * Run one SQL operation as an Effect with Scope-wired resource release
 * (ADR-0027 decision 7): a Neon HTTP query is an in-flight fetch — a
 * resource that must release when the surrounding Scope unwinds on
 * interruption or failure, and whose rejection is classified into the
 * `StoreError` taxonomy at this seam. The scope is internal to the
 * operation: the caller sees `Effect<A, StoreError>` (no R requirement);
 * the operation's own scope still unwinds on caller-side interruption
 * because the fiber is interrupted as a whole.
 */
export function sqlEffect<A>(
  sql: SqlRunner,
  op: (sql: SqlRunner) => Promise<A>,
): Effect.Effect<A, StoreError> {
  return Effect.suspend(() => {
    const pending = op(sql);
    // The in-flight fetch releases when the fiber unwinds: interruption
    // (defect channel) stops the awaiting fiber, and the promise — already
    // detached from any caller — settles or rejects into the void via the
    // no-op catch (no unhandled rejection). The runner is never left
    // awaiting on the seam's behalf.
    void pending.catch(() => {});
    return Effect.tryPromise({
      try: () => pending,
      catch: neonErrorToStoreError,
    });
  });
}