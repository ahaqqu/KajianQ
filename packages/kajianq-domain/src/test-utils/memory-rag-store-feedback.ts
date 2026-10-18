import { Effect } from "effect";
import { FEEDBACK_INITIAL_STATUS } from "@app/contracts";
import type { AnswerFeedbackTarget, FeedbackInsert, RagStore } from "@app/infra";
import { canonicalUuid } from "./memory-rag-store-uuid";

/** Feedback methods of the in-memory RagStore, sharing the main factory's maps by reference. */
export type MemoryFeedbackState = {
  chatMessages: Map<
    string,
    { sessionId: string; role: string; content: string; answerTraceId: string | null }
  >;
  /** Traces keyed by message id. */
  traces: Map<string, unknown>;
  /** Traces keyed by trace row id (the FK stand-in for answer_traces.id). */
  traceRows: Map<string, unknown>;
  /** Trace owners by message id, as inserted. */
  traceOwners: Map<string, string | null>;
  /** Trace owners by row id (the dual-id resolution the feedback route uses). */
  traceRowOwners: Map<string, string | null>;
  /** Trace row id → the canonical message id it was inserted under. */
  traceRowMessageIds: Map<string, string>;
  feedback: Map<string, FeedbackInsert & { id: string }>;
  nextId: () => number;
};

export function memoryFeedbackMethods(
  state: MemoryFeedbackState,
): Pick<RagStore, "insertFeedback" | "getAnswerFeedbackTarget"> {
  return {
    insertFeedback(input: FeedbackInsert) {
      return Effect.sync(() => {
        // Upsert mirroring the Postgres adapter's ON CONFLICT: one verdict per
        // (user, answer, element); a repeat updates rating/free text/queue state
        // in place and keeps the original row id.
        const key = (row: FeedbackInsert) =>
          `${row.userId}|${row.messageId}|${row.anchorType}|${row.anchorId ?? ""}|${row.category ?? ""}`;
        for (const [id, row] of state.feedback) {
          if (key(row) === key(input)) {
            state.feedback.set(id, {
              ...row,
              rating: input.rating,
              freeText: input.freeText,
              status: input.status ?? FEEDBACK_INITIAL_STATUS,
            });
            return id;
          }
        }
        const id = `fb${state.nextId()}`;
        state.feedback.set(id, { ...input, status: input.status ?? FEEDBACK_INITIAL_STATUS, id });
        return id;
      });
    },
    getAnswerFeedbackTarget(messageId) {
      return Effect.sync(() => {
        // Dual-id resolution: the id may be the trace's `message_id` (the live
        // stream's meta; a TEXT column the adapter compares exactly) or a
        // rehydrated chat row id (`chat_messages.id`, uuid-typed, so that OR arm
        // casts and canonicalises case) — the Postgres adapter resolves both.
        let trace = state.traces.get(messageId);
        let owner = state.traceOwners.get(messageId) ?? null;
        let chatRow = undefined;
        let canonicalMessageId = messageId;
        if (trace === undefined) {
          chatRow = state.chatMessages.get(canonicalUuid(messageId));
          const traceId = chatRow?.answerTraceId ?? null;
          if (traceId === null) return null;
          trace = state.traceRows.get(traceId);
          owner = state.traceRowOwners.get(traceId) ?? null;
          canonicalMessageId = state.traceRowMessageIds.get(traceId) ?? messageId;
        }
        if (trace === undefined) return null;
        const traceId = (trace as { id?: string }).id;
        const answerText =
          (chatRow ?? [...state.chatMessages.values()].find((m) => m.answerTraceId === traceId))
            ?.content ?? null;
        const target: AnswerFeedbackTarget = {
          // The trace's canonical message id: the caller keys the feedback row
          // by this, never by the looked-up alias.
          messageId: canonicalMessageId,
          userId: owner,
          trace: trace as never,
          answerText,
        };
        return target;
      });
    },
  };
}
