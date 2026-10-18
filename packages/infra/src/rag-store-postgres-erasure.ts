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
 * The transaction-local setting the postcondition statements read the subject
 * id from. A `DO` block cannot take bind parameters, so the id is bound once by
 * `set_config(…, true)` at the head of the batch and read back with
 * `current_setting(...)` in the assertions — never interpolated into statement
 * text. The `true` scopes it to this transaction, so it cannot leak into the
 * next one on the same connection. The assertions spell the name as a literal
 * because their bodies are not parsed for parameters; a test pins every
 * occurrence to this constant.
 */
export const ERASURE_SUBJECT_SETTING = "kajianq.erasure.subject";

/**
 * Erase one user's subtree in ONE transaction: the child sweeps name every table
 * explicitly, so the erasure does not rest on the FK cascade alone — the cascade
 * is the backstop that catches a child row committed between a sweep and the
 * parent delete. The parent delete is LAST, so a row inserted by an in-flight
 * chat turn either commits before it (and is cascaded) or blocks on its lock and
 * then fails its own FK check: no write can land after the commit.
 *
 * The sweeps are followed by postcondition statements in the SAME transaction,
 * so a surviving row makes one of them raise — the transaction rolls back and
 * `{ deleted: true }` only ever covers an empty subtree. Every table a cascading
 * foreign-key path from `users` reaches is counted: `users`, `sessions`,
 * `chat_sessions`, `answer_traces` and `feedback` after the deletes, and
 * `chat_messages` between its own sweep and the `chat_sessions` delete — its
 * owner is transitive (`session_id → chat_sessions.user_id`), so that is the
 * only point where it can still be attributed to the subject.
 *
 * A row written with a NULL owner — `chat_sessions.user_id`,
 * `answer_traces.user_id` and `feedback.user_id` are nullable — is not matched
 * by any of these predicates and survives the call silently: the erasure cannot
 * attribute it to a subject, and nothing here can tell it apart from another
 * user's row. The postcondition is not a detector for it; the only detectors are
 * a `NOT NULL` migration (the owner's decision) or an out-of-band audit of the
 * rows whose owner is NULL.
 */
export function eraseUserTree(sql: SqlRunner, userId: string): Effect.Effect<void, StoreError> {
  return Effect.asVoid(
    sqlEffect(sql, () =>
      sql.transaction([
        sql`SELECT set_config(${ERASURE_SUBJECT_SETTING}, ${userId}, true)`,
        sql`
            DELETE FROM chat_messages
            WHERE session_id IN (SELECT id FROM chat_sessions WHERE user_id = ${userId})
          `,
        sql`
            DO $$
            DECLARE residual text;
            BEGIN
              SELECT string_agg(verified_table, ', ') INTO residual FROM (
                SELECT 'chat_messages' AS verified_table
                WHERE EXISTS (
                  SELECT 1
                  FROM chat_messages m
                  JOIN chat_sessions s ON s.id = m.session_id
                  WHERE s.user_id = current_setting('kajianq.erasure.subject')::uuid
                )
              ) checked;
              IF residual IS NOT NULL THEN
                RAISE EXCEPTION 'user erasure left rows behind in: %', residual
                  USING ERRCODE = '23514';
              END IF;
            END $$
          `,
        sql`DELETE FROM feedback WHERE user_id = ${userId}`,
        sql`DELETE FROM answer_traces WHERE user_id = ${userId}`,
        sql`DELETE FROM chat_sessions WHERE user_id = ${userId}`,
        sql`DELETE FROM sessions WHERE user_id = ${userId}`,
        sql`DELETE FROM users WHERE id = ${userId}`,
        sql`
            DO $$
            DECLARE residual text;
            BEGIN
              SELECT string_agg(verified_table, ', ') INTO residual FROM (
                SELECT 'users' AS verified_table
                WHERE EXISTS (
                  SELECT 1 FROM users
                  WHERE id = current_setting('kajianq.erasure.subject')::uuid
                )
                UNION ALL
                SELECT 'sessions' AS verified_table
                WHERE EXISTS (
                  SELECT 1 FROM sessions
                  WHERE user_id = current_setting('kajianq.erasure.subject')::uuid
                )
                UNION ALL
                SELECT 'chat_sessions' AS verified_table
                WHERE EXISTS (
                  SELECT 1 FROM chat_sessions
                  WHERE user_id = current_setting('kajianq.erasure.subject')::uuid
                )
                UNION ALL
                SELECT 'answer_traces' AS verified_table
                WHERE EXISTS (
                  SELECT 1 FROM answer_traces
                  WHERE user_id = current_setting('kajianq.erasure.subject')::uuid
                )
                UNION ALL
                SELECT 'feedback' AS verified_table
                WHERE EXISTS (
                  SELECT 1 FROM feedback
                  WHERE user_id = current_setting('kajianq.erasure.subject')::uuid
                )
              ) checked;
              IF residual IS NOT NULL THEN
                RAISE EXCEPTION 'user erasure left rows behind in: %', residual
                  USING ERRCODE = '23514';
              END IF;
            END $$
          `,
      ]),
    ),
  );
}
