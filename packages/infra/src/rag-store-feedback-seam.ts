import type { Effect } from "effect";
import type { Trace } from "@app/contracts";
import type { StoreError } from "@app/rag-core";

/** Feedback half of the `RagStore` seam; `RagStore` extends it, so consumers
 * see one unchanged seam. The anchor vocabulary is the CALLER's: `anchorType`,
 * `anchorId` and `category` are opaque pass-throughs the store persists
 * verbatim — the shared contract owns the vocabulary, the route enforces it. */

/** A persisted feedback row's insert shape; the server fills id/created_at. */
export type FeedbackInsert = {
  /** The answer message the feedback is about. */
  messageId: string;
  /** The user the feedback is attributed to; cascade-deletes. */
  userId: string;
  /** −1 or 1 (the column CHECK); anchored flags persist as −1. */
  rating: 1 | -1;
  anchorType: string;
  /** The trace element identifier, when the flag anchors one. */
  anchorId: string | null;
  category: string | null;
  freeText: string | null;
  /** The review-queue state; the store defaults to the queue's inbox state. */
  status?: string;
};

/** What a feedback flag anchors to: the answer's Trace, its owner, and the
 * answer text. `answerText` joins through `chat_messages.answer_trace_id` —
 * the client-facing `message_id` is the TRACE's key, not the chat row id. */
export type AnswerFeedbackTarget = {
  /** The trace's CANONICAL message id: the caller may have looked the target up
   * by either identifier, but the store keys the feedback row by this one. */
  messageId: string;
  /** The trace's owning user; null when unowned. */
  userId: string | null;
  trace: Trace;
  answerText: string | null;
};

export interface RagStoreFeedback {
  /** Persist one feedback row (anonymous thumb or trace-anchored flag) against
   * an answer message and return the id of the stored row. A repeat verdict on
   * the same (user, answer, element) updates that row in place and returns the
   * same id. The `feedback.rating` column admits only −1/1; the shared contract
   * decides which wire shape maps to which. */
  insertFeedback(input: FeedbackInsert): Effect.Effect<string, StoreError>;

  /** The feedback target for one answer message: the persisted Trace plus its
   * owning user id, or null when no trace exists. The caller validates the
   * anchor and the ownership; the store just fetches. */
  getAnswerFeedbackTarget(
    messageId: string,
  ): Effect.Effect<AnswerFeedbackTarget | null, StoreError>;
}
