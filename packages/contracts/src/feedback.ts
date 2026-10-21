import * as v from "valibot";
import { STORABLE_TEXT_PATTERN } from "./chat";

/**
 * Feedback API contracts (ADR-0007): the `POST /v1/feedback` surface.
 * Anonymous thumbs up/down per answer, plus trace-anchored flags — the user
 * reports the exact failing element (wrong citation, irrelevant chunk, bad
 * machine translation, questionable grade) by referencing an identifier from
 * the shared Trace/citation contract, never free-form coordinates
 * (ADR-0007: "trace-anchored feedback targets identifiers from
 * the shared contract only").
 *
 * One request carries EXACTLY ONE of `rating` (an anonymous thumb on the
 * whole answer) or `anchor` (a flag on a specific element) — a payload with
 * neither, or with both, is malformed and rejected before the store is
 * touched. Anchored flags are always negative feedback: the store records
 * them with rating −1 (the `feedback.rating` CHECK admits only −1/1).
 */

/** A thumb on the whole answer; the wire word, not the ±1 column value. */
export const FeedbackRatingSchema = v.picklist(["up", "down"]);

export type FeedbackRating = v.InferOutput<typeof FeedbackRatingSchema>;

/** The element class a flag anchors to. `answer` is reserved for thumbs. */
export const FeedbackAnchorTypeSchema = v.picklist(["chunk", "citation", "translation", "grade"]);

export type FeedbackAnchorType = v.InferOutput<typeof FeedbackAnchorTypeSchema>;

/**
 * Why the element fails (CONTEXT.md "Feedback anchor"). Each reason pairs
 * with exactly one anchor type — the pairing is enforced HERE, by the
 * variant below, so a malformed combination ("irrelevant_chunk" anchored to
 * a grade badge) cannot even parse, let alone reach the store.
 */
export const FeedbackCategorySchema = v.picklist([
  "wrong_citation",
  "irrelevant_chunk",
  "bad_machine_translation",
  "questionable_grade",
]);

export type FeedbackCategory = v.InferOutput<typeof FeedbackCategorySchema>;

/**
 * A flag on one trace-anchored element. `id` is the element's identifier as
 * the client saw it in a server-derived frame:
 *   - `chunk` → the trace chunk id (the Trace panel's rows);
 *   - `citation` / `translation` / `grade` → the citation label (the chip and
 *     its passage sheet). The server re-derives the citations frame from the
 *     persisted trace and rejects a label it does not ground.
 */
export const FeedbackAnchorSchema = v.variant("type", [
  v.object({
    type: v.literal("chunk"),
    category: v.literal("irrelevant_chunk"),
    id: v.pipe(v.string(), v.minLength(1)),
  }),
  v.object({
    type: v.literal("citation"),
    category: v.literal("wrong_citation"),
    id: v.pipe(v.string(), v.minLength(1)),
  }),
  v.object({
    type: v.literal("translation"),
    category: v.literal("bad_machine_translation"),
    id: v.pipe(v.string(), v.minLength(1)),
  }),
  v.object({
    type: v.literal("grade"),
    category: v.literal("questionable_grade"),
    id: v.pipe(v.string(), v.minLength(1)),
  }),
]);

export type FeedbackAnchor = v.InferOutput<typeof FeedbackAnchorSchema>;

/**
 * Optional colour on either shape, stored verbatim in `free_text text`. The
 * field carries the shared storability rule (`STORABLE_TEXT_PATTERN`) rather
 * than a second character class: `text` cannot hold U+0000, and an unpaired
 * surrogate cannot be UTF-8 encoded — a write would store U+FFFD, a silently
 * different report than the user sent. The cap runs first, so an over-length
 * report stays the length issue; `v.regex` publishes the rule in
 * `/openapi.json` for the same reason it does on the chat message.
 */
const FEEDBACK_FREE_TEXT_MAX_LENGTH = 2000;

const STORABLE_TEXT = new RegExp(STORABLE_TEXT_PATTERN);

const FeedbackFreeTextSchema = v.optional(
  v.pipe(
    v.string(),
    v.maxLength(FEEDBACK_FREE_TEXT_MAX_LENGTH),
    v.regex(
      STORABLE_TEXT,
      `Free text must be storable as text: no U+0000 and no unpaired surrogate (up to ${FEEDBACK_FREE_TEXT_MAX_LENGTH} characters).`,
    ),
    v.description(
      `Optional free text on either feedback shape, capped at ${FEEDBACK_FREE_TEXT_MAX_LENGTH} UTF-16 code units measured on the raw string with no trim — an astral character counts as two, so the JSON Schema maxLength (a code-point count) admits a body this cap refuses. The pattern admits no U+0000 and no unpaired surrogate: U+0000 is a value the store refuses, and an unpaired surrogate would be stored as U+FFFD, a silently different report; both answer 400 invalid_request before auth or the store. Every other control character is storable and accepted.`,
    ),
  ),
);

/**
 * The request body. `messageId` is the answer's message id — the
 * `chat_messages.id` the stream's `meta` frame and the rehydration transcript
 * both carry (a uuid, which is why a malformed address is a contract refusal);
 * `freeText` is optional color for either shape (spec §2: "Free-text
 * optional"), capped so a report cannot smuggle in an essay (or personal data
 * beyond a sentence).
 *
 * The one-shape invariant is STRUCTURAL, not a cross-field check: the schema
 * is a union of the two valid shapes, each forbidding the other key with
 * `v.optional(v.never())`. A check added to a flat object never reaches the
 * emitted OpenAPI document (hono-openapi resolves only the object), so the doc
 * would show a shape the route answers 400 for. The union makes the doc carry
 * the same rule the validator enforces.
 */
export const FeedbackThumbShape = v.object({
  messageId: v.pipe(v.string(), v.uuid()),
  rating: FeedbackRatingSchema,
  anchor: v.optional(v.never()),
  freeText: FeedbackFreeTextSchema,
});

export const FeedbackFlagShape = v.object({
  messageId: v.pipe(v.string(), v.uuid()),
  rating: v.optional(v.never()),
  anchor: FeedbackAnchorSchema,
  freeText: FeedbackFreeTextSchema,
});

export const FeedbackRequestSchema = v.union([FeedbackThumbShape, FeedbackFlagShape]);

export type FeedbackRequest = v.InferOutput<typeof FeedbackRequestSchema>;

/**
 * The review-queue state a fresh row starts in — the one constant the stores'
 * insert default and the route's echoed response share, so the "pending"
 * vocabulary lives in the contract, not as scattered literals.
 */
export const FEEDBACK_INITIAL_STATUS = "pending";

/** The persisted feedback row, echoed so the client sees its anchor landed. */
export const FeedbackResponseSchema = v.object({
  /** The row this write inserted or updated; what a repeat submission answers
   * is stated once in this field's `description` (canonical: that description). */
  id: v.pipe(
    v.string(),
    v.minLength(1),
    v.description(
      "The stored feedback row's id: a second submission for the same user, answer and anchor updates that row in place, so it answers this same id; a different anchor is a different row with its own id.",
    ),
  ),
  messageId: v.pipe(v.string(), v.minLength(1)),
  /** The stored thumb; anchored flags persist as an implicit "down". */
  rating: v.nullable(FeedbackRatingSchema),
  anchor: v.nullable(
    v.object({
      type: FeedbackAnchorTypeSchema,
      category: FeedbackCategorySchema,
      id: v.pipe(v.string(), v.minLength(1)),
    }),
  ),
  /** The admin review queue state (spec §4): a fresh report starts pending. */
  status: v.picklist(["pending", "accepted", "rejected"]),
});

export type FeedbackResponse = v.InferOutput<typeof FeedbackResponseSchema>;

/** JSON error payload (validation/auth/anchor failures). */
export const FeedbackErrorSchema = v.object({
  error: v.pipe(v.string(), v.minLength(1)),
});

export type FeedbackError = v.InferOutput<typeof FeedbackErrorSchema>;
