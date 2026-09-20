import { Effect } from "effect";
import { FEEDBACK_INITIAL_STATUS, type Trace } from "@app/contracts";
import type { AnswerFeedbackTarget, FeedbackInsert, RagStore } from "./rag-store";
import { constraintError, parseTrace } from "./rag-store-shared";
import { sqlEffect, type SqlRunner } from "./rag-store-postgres-errors";

/**
 * Answer-trace and feedback methods of the Postgres RagStore adapter, split from
 * `rag-store-postgres.ts` to respect the agentic size limits. Part of the Postgres
 * adapter SQL surface (ADR-0027 decision 7): the store writes/parses the
 * @app/contracts `Trace` shape verbatim (ADR-0007) — never a parallel schema
 * — and contract violations are `constraint`-class StoreErrors. The feedback
 * methods (#13) share this module because the trace anchors them
 * (`answer_traces` is the feedback target): the anchor vocabulary arrives as
 * opaque values (the seam's domain-agnostic pass-through rule) — the shared
 * contract owns it, the route enforces it, the store only persists it.
 */
/**
 * True when the string is the canonical hyphenated uuid form — the only shape
 * `chat_messages.id` is ever generated in (`gen_random_uuid()`), and the only
 * shape safe to hand to the `::uuid` cast. Anything else is a message-id key
 * lookup, never a row-id lookup.
 */
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
      // Trace contract violations are constraint-class: the input, not the
      // store, is bad — deterministic, never retried into place.
      const parsed = Effect.try({
        try: () => parseTrace(input.trace),
        catch: constraintError,
      });
      // The row id is the STORE's, not the contract's: this column is `uuid`
      // while `Trace.id` is any non-empty string, so the two cannot always
      // agree. Callers must persist dependent rows (notably a chat message's
      // `answer_trace_id`, which FKs to this column) using the id returned
      // here — assuming `trace.id` instead silently broke every assistant
      // message write, which the live staging smoke caught as a 500.
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

    // The FK read (#11): `chat_messages.answer_trace_id` holds THIS column's
    // id, so a transcript rehydrates its traces by row id, not message id.
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
          // Tolerant reader (ADR-0007 amendment): the Trace contract only ever
          // ADDS optional fields (versioned), so parseTrace accepts older
          // traces and strips unknown future keys rather than failing. Never
          // add a required field to TraceSchema without a migration of
          // persisted traces. A corrupt persisted trace is constraint-class
          // (schema drift), surfaced — never silently coerced.
          return Effect.try({
            try: () => parseTrace(row.trace) as Trace | null,
            catch: constraintError,
          });
        },
      );
    },

    insertFeedback(input: FeedbackInsert) {
      const id = crypto.randomUUID();
      // Upsert (thermo-review A1): the 0003 functional unique index keys one
      // verdict per (user, answer, element) on the same COALESCE'd expression
      // list, so a repeat thumb or a re-submitted flag updates the row in
      // place — rating, free text, and queue state refresh, the id (and the
      // row count the review queue shows) stay stable. `user_id` NULL never
      // conflicts (Postgres NULLs are distinct); the route always attributes.
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
      // One read for the whole feedback target (#13): the trace, its owner,
      // and the answer text joined through `chat_messages.answer_trace_id`.
      // The caller's id may be EITHER identifier the user's client holds:
      // the live stream's `meta.messageId` (the trace's `message_id`) or a
      // rehydrated transcript row id (`chat_messages.id` — the store
      // generates that one, so it is never equal to the trace key). The row
      // id is uuid-typed, so the OR arm casts; a non-uuid caller id (the
      // seam is stricter than the route's contract, thermo-review A4) must
      // not 500 at the cast — it can only ever match `t.message_id`, so the
      // cast arm is simply omitted. Either way the target carries the
      // trace's CANONICAL message id (thermo-review A2): the caller keys the
      // feedback row by it, so the same answer is never stored two ways.
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
          // Tolerant reader (ADR-0007 amendment), same as every trace read:
          // older persisted traces stay parseable; a corrupt one is
          // constraint-class, never silently coerced.
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
