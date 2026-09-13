import type { Effect } from "effect";
import type { Trace } from "@app/contracts";
import type { StoreError } from "@app/rag-core";

/**
 * Feedback half of the `RagStore` seam (#13), split from `rag-store.ts` to
 * respect the agentic 300-line file cap — the `RagStore` interface extends
 * this one, so consumers see one unchanged seam. The anchor vocabulary is the
 * CALLER's: `anchorType`, `anchorId`, and `category` are opaque pass-through
 * values, exactly like `metadata` — the engine stores them verbatim and
 * interprets nothing (the shared @app/contracts feedback contract owns the
 * vocabulary; the API route enforces it).
 */

/** A persisted feedback row's insert shape (#13): server fills id/created_at. */
export type FeedbackInsert = {
  /** The answer message the feedback is about. */
  messageId: string;
  /** The (anonymous) user the feedback is attributed to; cascade-deletes. */
  userId: string;
  /** −1 or 1 (the column CHECK); anchored flags persist as −1. */
  rating: 1 | -1;
  /** Opaque element class (e.g. the contract's `chunk|citation|...|answer`). */
  anchorType: string;
  /** The trace element identifier, when the feedback anchors one. */
  anchorId: string | null;
  /** Opaque reason category, when the feedback anchors one. */
  category: string | null;
  freeText: string | null;
  /** The review-queue state; the store defaults to the queue's inbox state. */
  status?: string;
};

/**
 * What a feedback flag anchors to (#13): the answer's Trace, its owner, and
 * the answer text — the exact inputs the server-side anchor validation needs
 * (the citations frame re-derivation reads the answer's inline spans), all in
 * one seam call. `answerText` joins through `chat_messages.answer_trace_id`
 * — the client-facing `message_id` is the TRACE's key, not the chat row's id
 * (the store generates that one), so a lookup by message id can only reach
 * the answer text through this join.
 */
export type AnswerFeedbackTarget = {
  /**
   * The trace's CANONICAL message id (the trace's `message_id` column,
   * thermo-review A2): the caller may have looked the target up by either
   * identifier the client holds — this is the one the store must key the
   * feedback row by, so the same answer is never keyed two ways.
   */
  messageId: string;
  /** The trace's owning user (ADR-0007 amendment); null when unowned. */
  userId: string | null;
  trace: Trace;
  /** The answer's persisted text, when its chat message row survives. */
  answerText: string | null;
};

export interface RagStoreFeedback {
  /**
   * Persist one feedback row (anonymous thumb or trace-anchored flag) against
   * an answer message. The `feedback.rating` column admits only −1/1; the
   * shared contract decides which wire shape maps to which.
   */
  insertFeedback(input: FeedbackInsert): Effect.Effect<string, StoreError>;

  /**
   * The feedback target for one answer message (#13): the persisted Trace
   * plus its owning user id, or null when no trace exists for the message.
   * The caller validates the anchor against the trace and the ownership
   * against the authenticated user — the store just fetches.
   */
  getAnswerFeedbackTarget(
    messageId: string,
  ): Effect.Effect<AnswerFeedbackTarget | null, StoreError>;
}
