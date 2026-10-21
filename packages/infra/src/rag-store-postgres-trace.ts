import { Effect } from "effect";
import { FEEDBACK_INITIAL_STATUS, type Trace } from "@app/contracts";
import {
  canonicalMessageId,
  type AnswerFeedbackTarget,
  type FeedbackInsert,
  type RagStore,
} from "./rag-store";
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
      // The message reference is stored in the same canonical form as the
      // `chat_messages.id` row it names: this column is TEXT and would otherwise
      // keep a caller's re-cased spelling while the uuid row stored lowercase.
      const messageId = canonicalMessageId(input.messageId);
      return Effect.flatMap(parsed, (trace) =>
        Effect.as(
          sqlEffect(
            sql,
            () =>
              sql`
            INSERT INTO answer_traces (id, message_id, user_id, trace)
            VALUES (
              ${id}, ${messageId}, ${input.userId},
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
      const canonicalId = canonicalMessageId(messageId);
      return Effect.flatMap(
        sqlEffect(
          sql,
          () =>
            sql`
          SELECT trace FROM answer_traces WHERE message_id = ${canonicalId}
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
      // The id must come from RETURNING: the column defaults to gen_random_uuid()
      // and DO UPDATE keeps the row's own id, so an id minted here names no row on
      // either path. `user_id` NULL never conflicts (Postgres NULLs are distinct).
      return Effect.flatMap(
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
          RETURNING id
        ` as Promise<{ id: string }[]>,
        ),
        (rows) => {
          const [row] = rows;
          if (!row) {
            return Effect.fail(constraintError(new Error("feedback upsert returned no row")));
          }
          return Effect.succeed(row.id);
        },
      );
    },

    getAnswerFeedbackTarget(messageId) {
      // One read for the whole feedback target: the trace, its owner, and the
      // answer text joined through `chat_messages.answer_trace_id`. The answer's
      // message id and its trace's `message_id` are written as one value, but the
      // store does not constrain them equal, so the read accepts either address a
      // client can hold — the live stream's `meta.messageId` or a rehydrated row
      // id. The row id is uuid-typed, so that arm casts; a non-uuid id can only
      // match `t.message_id` and omits the cast arm rather than failing. The
      // target carries the trace's message id, the canonical key feedback rows use.
      // The reference is canonical on write, so an incoming re-cased spelling is
      // canonicalised before it is compared either way.
      const canonicalId = canonicalMessageId(messageId);
      const byEither = isUuid(canonicalId);
      return Effect.flatMap(
        sqlEffect(sql, () =>
          byEither
            ? (sql`
          SELECT t.message_id AS trace_message_id, t.user_id AS user_id, t.trace AS trace,
                 m.content AS answer_text
          FROM answer_traces t
          LEFT JOIN chat_messages m ON m.answer_trace_id = t.id
          WHERE t.message_id = ${canonicalId}
             OR m.id = ${canonicalId}::uuid
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
          WHERE t.message_id = ${canonicalId}
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
