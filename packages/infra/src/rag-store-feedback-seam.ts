import type { Effect } from "effect";
import type { Trace } from "@app/contracts";
import type { StoreError } from "@app/rag-core";
import type { ChatMessage } from "./rag-store";

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

/** What a feedback flag anchors to: the answer's Trace and its owner (#13). */
export type AnswerFeedbackTarget = {
  /** The trace's owning user (ADR-0007 amendment); null when unowned. */
  userId: string | null;
  trace: Trace;
};

export interface RagStoreFeedback {
  /**
   * Persist one feedback row (anonymous thumb or trace-anchored flag) against
   * an answer message. The `feedback.rating` column admits only −1/1; the
   * shared contract decides which wire shape maps to which.
   */
  insertFeedback(input: FeedbackInsert): Effect.Effect<string, StoreError>;

  /**
   * One chat message row by id, or null when absent. Feedback anchoring (#13)
   * reads the answer's text to re-derive its citation frame; a generic
   * single-message read keeps that a seam call, not a SQL reach-through.
   */
  getChatMessage(id: string): Effect.Effect<ChatMessage | null, StoreError>;

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
