import { Effect } from "effect";
import { FEEDBACK_INITIAL_STATUS, type Trace } from "@app/contracts";
import type { AnswerFeedbackTarget, FeedbackInsert, RagStore } from "./rag-store";
import { constraintError, parseTrace } from "./rag-store-shared";
import { sqlEffect, type SqlRunner } from "./rag-store-postgres-errors";

/** Answer-trace and feedback methods of the Postgres RagStore adapter. The store
 * writes and parses the `@app/contracts` `Trace` shape verbatim — never a
 * parallel schema — and contract violations are `constraint`-class StoreErrors;
 * feedback shares the module because the trace anchors it. */

/** True for the canonical hyphenated uuid form — the only shape
 * `chat_messages.id` is generated in, and the only one safe for the `::uuid` cast. */
function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function postgresTraceMethods(
  sql: SqlRunner,
): Pick<
  RagStore,
  | "insertAnswerTrace"
  | "getAnswerTraceByMessage"
  | "getAnswerTraceById"
  | "insertFeedback"
  | "getAnswerFeedbackTarget"
> {
  return {
    insertAnswerTrace(input) {
      // Trace contract violations are constraint-class: the input, not the store,
      // is bad — deterministic, never retried into place.
      const parsed = Effect.try({
        try: () => parseTrace(input.trace),
        catch: constraintError,
      });
      // The row id is the STORE's, not the contract's: this column is `uuid`
      // while `Trace.id` is any non-empty string. Callers must persist dependent
      // rows (notably an `answer_trace_id` FK) using the id returned here.
      const id = crypto.randomUUID();
      return Effect.flatMap(parsed, (trace) =>
        Effect.as(
          sqlEffect(
            sql,
            () =>
              sql`
            INSERT INTO answer_traces (id, message_id, user_id, trace)
            VALUES (
              ${id}, ${input.messageId}, ${input.userId},
              ${JSON.stringify(trace)}::jsonb
            )
          ` as Promise<unknown[]>,
          ),
          id,
        ),
      );
    },

    // `chat_messages.answer_trace_id` holds THIS column's id, so a transcript
    // rehydrates its traces by row id, not by message id.
    getAnswerTraceById(id) {
      return Effect.flatMap(
        sqlEffect(
          sql,
          () =>
            sql`
          SELECT trace FROM answer_traces WHERE id = ${id}::uuid
        ` as Promise<{ trace: unknown }[]>,
        ),
        (rows) => {
          const [row] = rows;
          if (!row) return Effect.succeed<Trace | null>(null);
          return Effect.try({
            try: () => parseTrace(row.trace) as Trace | null,
            catch: constraintError,
          });
        },
      );
    },

    getAnswerTraceByMessage(messageId) {
      return Effect.flatMap(
        sqlEffect(
          sql,
          () =>
            sql`
          SELECT trace FROM answer_traces WHERE message_id = ${messageId}
        ` as Promise<{ trace: unknown }[]>,
        ),
        (rows) => {
          const [row] = rows;
          if (!row) return Effect.succeed<Trace | null>(null);
          // Tolerant reader: the Trace contract only ever ADDS optional fields,
          // so parseTrace accepts older traces and strips unknown future keys.
          // A corrupt persisted trace is constraint-class, never coerced.
          return Effect.try({
            try: () => parseTrace(row.trace) as Trace | null,
            catch: constraintError,
          });
        },
      );
    },

    insertFeedback(input: FeedbackInsert) {
      const id = crypto.randomUUID();
      // Upsert: the functional unique index keys one verdict per
      // (user, answer, element) on the same COALESCE'd expression list, so a
      // repeat thumb updates the row in place — the id and row count stay stable.
      // `user_id` NULL never conflicts (Postgres NULLs are distinct).
      return Effect.as(
        sqlEffect(
          sql,
          () =>
            sql`
          INSERT INTO feedback (
            message_id, user_id, rating, anchor_type, anchor_id, category, free_text, status
          )
          VALUES (
            ${input.messageId}, ${input.userId}, ${input.rating}, ${input.anchorType},
            ${input.anchorId}, ${input.category}, ${input.freeText},
            ${input.status ?? FEEDBACK_INITIAL_STATUS}
          )
          ON CONFLICT (
            user_id, message_id, anchor_type,
            COALESCE(anchor_id, ''), COALESCE(category, '')
          )
          DO UPDATE SET
            rating = EXCLUDED.rating,
            free_text = EXCLUDED.free_text,
            status = EXCLUDED.status,
            created_at = now()
        ` as Promise<unknown[]>,
        ),
        id,
      );
    },

    getAnswerFeedbackTarget(messageId) {
      // One read for the whole feedback target: the trace, its owner, and the
      // answer text joined through `chat_messages.answer_trace_id`. The caller's
      // id may be EITHER identifier the client holds — the stream's
      // `meta.messageId` (the trace's `message_id`) or a rehydrated transcript
      // row id (`chat_messages.id`). That row id is uuid-typed, so the OR arm
      // casts; a non-uuid id can only match `t.message_id` and omits the cast
      // arm rather than failing. The target carries the trace's CANONICAL id.
      const byEither = isUuid(messageId);
      return Effect.flatMap(
        sqlEffect(sql, () =>
          byEither
            ? (sql`
          SELECT t.message_id AS trace_message_id, t.user_id AS user_id, t.trace AS trace,
                 m.content AS answer_text
          FROM answer_traces t
          LEFT JOIN chat_messages m ON m.answer_trace_id = t.id
          WHERE t.message_id = ${messageId}
             OR m.id = ${messageId}::uuid
        ` as Promise<
                {
                  trace_message_id: string;
                  user_id: string | null;
                  trace: unknown;
                  answer_text: string | null;
                }[]
              >)
            : (sql`
          SELECT t.message_id AS trace_message_id, t.user_id AS user_id, t.trace AS trace,
                 m.content AS answer_text
          FROM answer_traces t
          LEFT JOIN chat_messages m ON m.answer_trace_id = t.id
          WHERE t.message_id = ${messageId}
        ` as Promise<
                {
                  trace_message_id: string;
                  user_id: string | null;
                  trace: unknown;
                  answer_text: string | null;
                }[]
              >),
        ),
        (rows) => {
          const row = rows[0];
          if (!row) return Effect.succeed<AnswerFeedbackTarget | null>(null);
          return Effect.map(
            Effect.try({
              try: () => parseTrace(row.trace) as Trace,
              catch: constraintError,
            }),
            (trace): AnswerFeedbackTarget => ({
              messageId: row.trace_message_id,
              userId: row.user_id,
              trace,
              answerText: row.answer_text,
            }),
          );
        },
      );
    },
  };
}
