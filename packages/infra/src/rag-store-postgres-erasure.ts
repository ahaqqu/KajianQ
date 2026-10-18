import { Effect } from "effect";
import { StoreError } from "@app/rag-core";
import { sqlEffect, type SqlRunner } from "./rag-store-postgres-errors";

/**
 * The Art. 17 erasure of an anonymous user's whole subtree (ADR-0007,
 * ADR-0043), split out of the session methods so the transaction and its
 * postcondition read as one unit. Executable SQL stays inside the Postgres
 * adapter surface; this module is one of its files.
 */

/**
 * The user-owned tables the erasure postcondition counts, in the order the
 * verification row returns them. Any row left in one of them after the
 * transaction's deletes is an incomplete erasure, whatever produced it.
 */
export const ERASURE_VERIFIED_TABLES = [
  "users",
  "sessions",
  "chat_sessions",
  "answer_traces",
  "feedback",
] as const;

export type ErasureVerifiedTable = (typeof ERASURE_VERIFIED_TABLES)[number];

type ResidualRow = Record<string, unknown>;

/**
 * The tables the erasure postcondition still finds rows in, read from its
 * verification row. It fails closed: a missing row (a driver resolving the batch
 * differently is a contract violation) reports every table rather than none, and
 * a count that is not a finite number is residual too — a postcondition never
 * passes on a value it could not read. Counts arrive as JS numbers because the
 * SELECT casts `count(*)` to `int`.
 */
export function erasureResiduals(row: ResidualRow | undefined): ErasureVerifiedTable[] {
  if (row === undefined) return [...ERASURE_VERIFIED_TABLES];
  return ERASURE_VERIFIED_TABLES.filter((table) => {
    const count = row[table];
    return typeof count !== "number" || !Number.isFinite(count) || count !== 0;
  });
}

/**
 * Erase one user's subtree in ONE transaction: the child sweeps name every table
 * explicitly, so the erasure does not rest on the FK cascade alone — the cascade
 * is the backstop that catches a child row committed between a sweep and the
 * parent delete. The parent delete is LAST, so a row inserted by an in-flight
 * chat turn either commits before it (and is cascaded) or blocks on its lock and
 * then fails its own FK check: no write can land after the commit.
 *
 * The final statement is the postcondition the caller's `{ deleted: true }`
 * claims: count every table the user can still be found in. A surviving row — a
 * nullable owner column written as NULL, a constraint missing from the deployed
 * schema, a table added later without a user FK — fails the transaction and so
 * the call, never a success response with rows left behind. `chat_messages` is
 * absent from the count because its owner is transitive (`session_id →
 * chat_sessions.user_id`): once the owning chat session is deleted the column
 * cannot be read back, so its sweep runs before that delete and the chat-session
 * FK cascade is its backstop.
 */
export function eraseUserTree(sql: SqlRunner, userId: string): Effect.Effect<void, StoreError> {
  return Effect.flatMap(
    sqlEffect(
      sql,
      () =>
        sql.transaction([
          sql`
            DELETE FROM chat_messages
            WHERE session_id IN (SELECT id FROM chat_sessions WHERE user_id = ${userId})
          `,
          sql`DELETE FROM feedback WHERE user_id = ${userId}`,
          sql`DELETE FROM answer_traces WHERE user_id = ${userId}`,
          sql`DELETE FROM chat_sessions WHERE user_id = ${userId}`,
          sql`DELETE FROM sessions WHERE user_id = ${userId}`,
          sql`DELETE FROM users WHERE id = ${userId}`,
          sql`
            SELECT
              (SELECT count(*)::int FROM users WHERE id = ${userId}) AS users,
              (SELECT count(*)::int FROM sessions WHERE user_id = ${userId}) AS sessions,
              (SELECT count(*)::int FROM chat_sessions WHERE user_id = ${userId}) AS chat_sessions,
              (SELECT count(*)::int FROM answer_traces WHERE user_id = ${userId}) AS answer_traces,
              (SELECT count(*)::int FROM feedback WHERE user_id = ${userId}) AS feedback
          `,
        ]) as Promise<unknown[][]>,
    ),
    (results) => {
      const row = Array.isArray(results)
        ? (results.at(-1)?.[0] as ResidualRow | undefined)
        : undefined;
      const residual = erasureResiduals(row);
      // An idempotent second call on an already-empty subtree still passes: every
      // count is 0 and the call is a no-op, never an error.
      return residual.length === 0
        ? Effect.void
        : Effect.fail(
            new StoreError({
              // Deterministic data state, not a retryable blip: the caller must
              // surface the failure, never report success.
              kind: "constraint",
              cause: new Error(`user erasure left rows behind in: ${residual.join(", ")}`),
            }),
          );
    },
  );
}
