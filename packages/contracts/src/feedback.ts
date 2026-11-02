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
export const FeedbackAnchorTypeSchema = v.picklist([
  "chunk",
  "citation",
  "translation",
  "grade",
  "chain",
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
 * The ceiling for every string a flag anchors with: the anchor `id` (a trace
 * chunk id or a citation label) and a chain row's own `grade` and `grader`.
 *
 * The bound is the transport's, not the element's. The write route refuses a
 * request body over its byte ceiling with `413 payload_too_large`, so a
 * contract that left these strings unbounded would publish a body the route
 * must refuse: a schema-valid report answered 413. The ceiling is generous
 * beside the values a trace actually grounds — a chunk id is a UUID, the
 * corpus's citation labels are a few dozen characters, a grade is one word and
 * a grader a name — while keeping the worst-case schema-valid body below the
 * byte ceiling. The bound counts code points, the same unit JSON Schema's
 * `maxLength` counts, so the published contract and the parse are one rule.
 */
export const FEEDBACK_ANCHOR_STRING_MAX_LENGTH = 200;

/**
 * The one code-point test the bounded feedback strings share. JSON Schema's
 * `maxLength` counts code points, while `String.prototype.length` counts
 * UTF-16 code units, so a `maxLength` action would refuse a string the
 * published bound admits. Counting through `Array.from` keeps both on the
 * published unit; the published `maxLength` is emitted from the same constant
 * as schema metadata.
 */
export function isWithinCodePointCap(value: string, cap: number): boolean {
  return Array.from(value).length <= cap;
}

/**
 * The one pipe every anchored string shares, so a request variant, the
 * response echo and the published `maxLength` cannot drift apart.
 *
 * The description is true of the value in both roles: it states the bound and
 * the unit, not what the write route answers. The request-only rejection
 * sentence lives on `FeedbackRequestAnchorSchema`, where a 400 can happen.
 */
export const FeedbackAnchorStringSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.check(
    (value) => isWithinCodePointCap(value, FEEDBACK_ANCHOR_STRING_MAX_LENGTH),
    `An anchored string is at most ${FEEDBACK_ANCHOR_STRING_MAX_LENGTH} code points.`,
  ),
  v.metadata({ maxLength: FEEDBACK_ANCHOR_STRING_MAX_LENGTH }),
  v.description(
    `A trace-anchored string — an anchor id (a trace chunk id or a citation label) or a chain row's own grade or grader — at most ${FEEDBACK_ANCHOR_STRING_MAX_LENGTH} code points on the raw string with no trim. JSON Schema maxLength counts the same code points, so the published bound and this check are one rule. The bound is what keeps the widest schema-valid feedback body within the route's request-body byte ceiling.`,
  ),
);

/**
 * A flag on one trace-anchored element. `id` is the element's identifier as
 * the client saw it in a server-derived frame:
 *   - `chunk` → the trace chunk id (the Trace panel's rows);
 *   - `citation` / `translation` / `grade` → the citation label (the chip and
 *     its passage sheet). The server re-derives the citations frame from the
 *     persisted trace and rejects a label it does not ground.
 *   - `chain` → the citation label plus the row's position in that citation's
 *     rendered `chains` list, and that row's own grade and grader when it has
 *     them. The server re-derives the row and rejects an anchor whose position,
 *     grade or grader does not match it; a chain anchor never names the
 *     passage's flattened grade.
 */
export const FeedbackAnchorSchema = v.variant("type", [
  v.object({
    type: v.literal("chunk"),
    category: v.literal("irrelevant_chunk"),
    id: FeedbackAnchorStringSchema,
  }),
  v.object({
    type: v.literal("citation"),
    category: v.literal("wrong_citation"),
    id: FeedbackAnchorStringSchema,
  }),
  v.object({
    type: v.literal("translation"),
    category: v.literal("bad_machine_translation"),
    id: FeedbackAnchorStringSchema,
  }),
  v.object({
    type: v.literal("grade"),
    category: v.literal("questionable_grade"),
    id: FeedbackAnchorStringSchema,
  }),
  v.object({
    type: v.literal("chain"),
    category: v.literal("questionable_grade"),
    id: FeedbackAnchorStringSchema,
    chainIndex: v.pipe(v.number(), v.integer(), v.minValue(0)),
    grade: v.optional(FeedbackAnchorStringSchema),
    grader: v.optional(FeedbackAnchorStringSchema),
  }),
]);

export type FeedbackAnchor = v.InferOutput<typeof FeedbackAnchorSchema>;

/**
 * The request-side anchor: the one shared pipe above plus the rejection the
 * write route can actually answer. The response echo uses
 * `FeedbackAnchorStringSchema` directly, so its description never claims a 400
 * a response cannot produce.
 */
const FeedbackRequestAnchorSchema = v.pipe(
  FeedbackAnchorSchema,
  v.description(
    "The trace-anchored element to flag. An anchor string over the published cap on `id`, `grade` or `grader` is 400 invalid_request before auth or the store.",
  ),
);

/**
 * Optional colour on either shape, stored verbatim in `free_text text`. The
 * field carries the shared storability rule (`STORABLE_TEXT_PATTERN`) rather
 * than a second character class: `text` cannot hold U+0000, and an unpaired
 * surrogate cannot be UTF-8 encoded — a write would store U+FFFD, a silently
 * different report than the user sent. The cap runs first, so an over-length
 * report stays the length issue; `v.regex` publishes the rule in
 * `/openapi.json` for the same reason it does on the chat message.
 */
export const FEEDBACK_FREE_TEXT_MAX_LENGTH = 2000;

const STORABLE_TEXT = new RegExp(STORABLE_TEXT_PATTERN);

const FeedbackFreeTextSchema = v.optional(
  v.pipe(
    v.string(),
    v.check(
      (value) => isWithinCodePointCap(value, FEEDBACK_FREE_TEXT_MAX_LENGTH),
      `Free text is at most ${FEEDBACK_FREE_TEXT_MAX_LENGTH} code points.`,
    ),
    v.metadata({ maxLength: FEEDBACK_FREE_TEXT_MAX_LENGTH }),
    v.regex(
      STORABLE_TEXT,
      `Free text must be storable as text: no U+0000 and no unpaired surrogate (up to ${FEEDBACK_FREE_TEXT_MAX_LENGTH} characters).`,
    ),
    v.description(
      `Optional free text on either feedback shape, capped at ${FEEDBACK_FREE_TEXT_MAX_LENGTH} code points measured on the raw string with no trim, the same unit as the published JSON Schema maxLength. The pattern admits no U+0000 and no unpaired surrogate: U+0000 is a value the store refuses, and an unpaired surrogate would be stored as U+FFFD, a silently different report; both answer 400 invalid_request before auth or the store. Every other control character is storable and accepted.`,
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
  anchor: FeedbackRequestAnchorSchema,
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
      id: FeedbackAnchorStringSchema,
      /** A chain anchor's row position and that row's own verdict, when graded. */
      chainIndex: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      grade: v.optional(FeedbackAnchorStringSchema),
      grader: v.optional(FeedbackAnchorStringSchema),
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
