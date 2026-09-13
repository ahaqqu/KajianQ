import * as v from "valibot";

/**
 * Feedback API contracts (#13, ADR-0007): the `POST /v1/feedback` surface.
 * Anonymous thumbs up/down per answer, plus trace-anchored flags — the user
 * reports the exact failing element (wrong citation, irrelevant chunk, bad
 * machine translation, questionable grade) by referencing an identifier from
 * the shared Trace/citation contract, never free-form coordinates
 * (ADR-0007 amendment 2: "trace-anchored feedback targets identifiers from
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
export const FeedbackAnchorTypeSchema = v.picklist([
  "chunk",
  "citation",
  "translation",
  "grade",
]);

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
 * The request body. `messageId` is the answer's message id (a uuid — the id
 * the chat route mints); `freeText` is optional color for either shape
 * (spec §2: "Free-text optional"), capped so a report cannot smuggle in an
 * essay (or personal data beyond a sentence).
 */
export const FeedbackRequestSchema = v.pipe(
  v.object({
    messageId: v.pipe(v.string(), v.uuid()),
    rating: v.optional(FeedbackRatingSchema),
    anchor: v.optional(FeedbackAnchorSchema),
    freeText: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  }),
  v.check(
    (req) =>
      // Exactly one feedback shape per request: a thumb or a flag, never
      // both, never neither (the module comment's invariant).
      (req.rating !== undefined) !== (req.anchor !== undefined),
  ),
);

export type FeedbackRequest = v.InferOutput<typeof FeedbackRequestSchema>;

/** The persisted feedback row, echoed so the client sees its anchor landed. */
export const FeedbackResponseSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
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
