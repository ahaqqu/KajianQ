import { Effect } from "effect";
import type { AnswerFeedbackTarget, FeedbackInsert, RagStore } from "@app/infra";

/**
 * Feedback methods of the in-memory RagStore (#13), split from
 * `memory-rag-store.ts` to respect the agentic size limits — same pattern as
 * `memory-rag-store-eval.ts`. The maps are owned by the main factory and
 * shared here by reference; ids are `fb<n>`/`msg<n>` stand-ins.
 */
export type MemoryFeedbackState = {
  /** All persisted chat messages by id (getChatMessage reads this). */
  chatMessages: Map<string, { sessionId: string; role: string; content: string; answerTraceId: string | null }>;
  /** Persisted traces keyed by message id (getAnswerFeedbackTarget reads this). */
  traces: Map<string, unknown>;
  /** Trace owners by message id, as inserted (ADR-0007 amendment). */
  traceOwners: Map<string, string | null>;
  /** Persisted feedback rows by id. */
  feedback: Map<string, FeedbackInsert & { id: string }>;
  nextId: () => number;
};

export function memoryFeedbackMethods(
  state: MemoryFeedbackState,
): Pick<RagStore, "insertFeedback" | "getChatMessage" | "getAnswerFeedbackTarget"> {
  return {
    insertFeedback(input: FeedbackInsert) {
      return Effect.sync(() => {
        const id = `fb${state.nextId()}`;
        state.feedback.set(id, { ...input, status: input.status ?? "pending", id });
        return id;
      });
    },
    getChatMessage(id) {
      return Effect.sync(() => {
        const row = state.chatMessages.get(id);
        if (!row) return null;
        // Insertion order stands in for created_at (no clock), like getChatMessages.
        const index = [...state.chatMessages.keys()].indexOf(id);
        return { ...row, id, createdAt: index };
      });
    },
    getAnswerFeedbackTarget(messageId) {
      return Effect.sync(() => {
        const trace = state.traces.get(messageId);
        if (trace === undefined) return null;
        const target: AnswerFeedbackTarget = {
          userId: state.traceOwners.get(messageId) ?? null,
          trace: trace as never,
        };
        return target;
      });
    },
  };
}
