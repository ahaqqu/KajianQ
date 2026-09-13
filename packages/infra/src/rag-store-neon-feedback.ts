import { Effect } from "effect";
import type { Trace } from "@app/contracts";
import type { AnswerFeedbackTarget, ChatMessage, FeedbackInsert, RagStore } from "./rag-store";
import { constraintError, parseTrace } from "./rag-store-shared";
import { sqlEffect, type SqlRunner } from "./rag-store-neon-errors";

/**
 * Feedback methods of the Neon RagStore adapter (#13), split from
 * `rag-store-neon.ts` to respect the agentic size limits. Part of the Neon
 * adapter SQL surface (ADR-0027 decision 7). The anchor vocabulary arrives as
 * opaque values (the seam's domain-agnostic pass-through rule) — the shared
 * contract owns it, the route enforces it, the store only persists it.
 */
export function neonFeedbackMethods(
  sql: SqlRunner,
): Pick<RagStore, "insertFeedback" | "getChatMessage" | "getAnswerFeedbackTarget"> {
  return {
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
