import type { Effect } from "effect";
import type { Trace } from "@app/contracts";
import type { StoreError } from "@app/rag-core";

/**
 * Trace half of the `RagStore` seam (ADR-0007), split from `rag-store.ts`
 * to respect the agentic 300-line file cap — the same split the corpus
 * (`rag-store-corpus-seam.ts`), eval (`rag-store-eval-seam.ts`), and feedback
 * (`rag-store-feedback-seam.ts`) halves already take. The `RagStore`
 * interface extends this one, so consumers see one unchanged seam.
 */
export interface RagStoreTrace {
  /**
   * Persist the Trace for one answer, owned by `userId`. The store writes
   * the @app/contracts `Trace` shape verbatim — it never re-serializes or
   * invents a parallel trace schema (ADR-0007). The user link makes the
   * trace cascade-delete with its owner on anonymous self-deletion
   * (ADR-0007 amendment).
   */
  insertAnswerTrace(input: {
    messageId: string;
    userId: string;
    trace: Trace;
  }): Effect.Effect<string, StoreError>;

  /** Fetch a persisted Trace by answer message id. */
  getAnswerTraceByMessage(messageId: string): Effect.Effect<Trace | null, StoreError>;

  /**
   * Fetch a persisted Trace by its ROW id — the value
   * `chat_messages.answer_trace_id` FKs (#11). Distinct from
   * `getAnswerTraceByMessage`: that column carries the route's answer
   * message id, not the chat message row's id.
   */
  getAnswerTraceById(id: string): Effect.Effect<Trace | null, StoreError>;
}
