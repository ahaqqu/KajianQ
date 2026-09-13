import { Effect } from "effect";
import type { Trace } from "@app/contracts";
import type { AnswerFeedbackTarget, ChatMessage, FeedbackInsert, RagStore } from "./rag-store";
import { constraintError, parseTrace } from "./rag-store-shared";
import { sqlEffect, type SqlRunner } from "./rag-store-neon-errors";

/**
 * Answer-trace and feedback methods of the Neon RagStore adapter, split from
 * `rag-store-neon.ts` to respect the agentic size limits. Part of the Neon
 * adapter SQL surface (ADR-0027 decision 7): the store writes/parses the
 * @app/contracts `Trace` shape verbatim (ADR-0007) — never a parallel schema
 * — and contract violations are `constraint`-class StoreErrors. The feedback
 * methods (#13) share this module because the trace anchors them
 * (`answer_traces` is the feedback target): the anchor vocabulary arrives as
 * opaque values (the seam's domain-agnostic pass-through rule) — the shared
 * contract owns it, the route enforces it, the store only persists it.
 */
export function neonTraceMethods(
  sql: SqlRunner,
): Pick<
  RagStore,
  | "insertAnswerTrace"
  | "getAnswerTraceByMessage"
  | "getAnswerTraceById"
  | "insertFeedback"
  | "getChatMessage"
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
            ${input.anchorId}, ${input.category}, ${input.freeText}, ${input.status ?? "pending"}
          )
        ` as Promise<unknown[]>,
        ),
        id,
      );
    },

    getChatMessage(id) {
      return Effect.map(
        sqlEffect(
          sql,
          () =>
            sql`
          SELECT id, session_id, role, content, answer_trace_id, created_at
          FROM chat_messages WHERE id = ${id}::uuid
        ` as Promise<
              {
                id: string;
                session_id: string;
                role: string;
                content: string;
                answer_trace_id: string | null;
                created_at: string | Date;
              }[]
            >,
        ),
        (rows) => {
          const row = rows[0];
          if (!row) return null;
          const message: ChatMessage = {
            id: row.id,
            sessionId: row.session_id,
            role: row.role,
            content: row.content,
            answerTraceId: row.answer_trace_id,
            createdAt: new Date(row.created_at).getTime(),
          };
          return message;
        },
      );
    },

    getAnswerFeedbackTarget(messageId) {
      return Effect.flatMap(
        sqlEffect(
          sql,
          () =>
            sql`
          SELECT user_id, trace FROM answer_traces WHERE message_id = ${messageId}
        ` as Promise<{ user_id: string | null; trace: unknown }[]>,
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
            (trace): AnswerFeedbackTarget => ({ userId: row.user_id, trace }),
          );
        },
      );
    },
  };
}
