import * as v from "valibot";
import { sourceRoutingDetailSchema } from "./trace-source-routing";

/**
 * Chat API contracts: the `/v1/chat` request/response surface — request body
 * validation plus the JSON error/meta payloads, shared by the route and the eval
 * harness client. The answer itself streams as SSE (`text/event-stream`).
 */

/**
 * The chat message ceiling, in characters — a hard COST bound, not a UX nicety:
 * the rate limiter caps request frequency, not request size (ADR-0041), so
 * without a ceiling a client can multiply what each accepted question spends.
 *
 * Length is in UTF-16 code units on the RAW string, before any trim: the bound
 * is on what the client sends, not on what a later stage would strip.
 */
export const CHAT_MESSAGE_MAX_LENGTH = 2000;

/**
 * A chat session id as a REQUEST value: `chat_sessions.id` is a Postgres `uuid`
 * column, and the adapter's `${sessionId}::uuid` cast raises before the
 * ownership check can answer — so a malformed id is refused here (`400` on the
 * request body, the route's existing `404` on the rehydration path param)
 * rather than surfacing as a server fault. A format check only: a well-formed
 * but unknown or foreign UUID is no existence oracle.
 *
 * Deliberately NOT applied to the server-produced `sessionId` members: the
 * `RagStore` seam types chat session ids as opaque strings, and a response
 * assertion is not a boundary.
 */
export const ChatSessionIdSchema = v.pipe(
  v.string(),
  v.uuid(),
  v.description(
    "The chat session's UUID (`chat_sessions.id`). A value that is not a UUID is rejected with 400 invalid_request before the store or any pipeline stage runs; a well-formed but unknown or foreign UUID answers the same 404 as a session that does not exist.",
  ),
);

/**
 * The predicate form of `ChatSessionIdSchema`: the rehydration route's `:id`
 * guard reads the SAME rule as the request body, never a second regex.
 */
export const isChatSessionId = (value: string): boolean => v.is(ChatSessionIdSchema, value);

/**
 * The storability rule in the one form both of its readers share: a sequence of
 * UTF-16 code units that are neither U+0000 nor a surrogate, or well-formed
 * surrogate pairs.
 *
 * Runtime validation and the published API documentation read this same
 * string. A custom `v.check` predicate has no JSON-Schema form, so publishing
 * it would leave `message` a bare string and every client generated from
 * `/openapi.json` would believe a body the route must refuse is valid; this
 * pattern IS the rule, so the emitted schema's `pattern` and the parse cannot
 * drift apart.
 */
export const STORABLE_TEXT_PATTERN = String.raw`^(?:[^\u0000\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$`;

/**
 * Compiled once from the published source, deliberately without the `g`/`y`
 * flags: `test` then carries no `lastIndex` state between the boundary parse
 * and any caller reading the predicate.
 */
const STORABLE_TEXT = new RegExp(STORABLE_TEXT_PATTERN);

/**
 * Can the store hold this text unchanged? A message is written to a Postgres
 * `text` column, which is stored in the database encoding, so the value must
 * be UTF-8 encodable and NUL-free: U+0000 is legal JSON and legal UTF-8 but no
 * `text` value may carry it, and an unpaired surrogate cannot be encoded at
 * all — a write of one stores U+FFFD, a silently different message than the
 * client sent. Both are therefore refused at the contract, before auth, the
 * store or any pipeline stage, with the same `400 invalid_request` an
 * over-length body gets.
 *
 * The decision is `STORABLE_TEXT_PATTERN`'s, not a second reading of the rule:
 * a high surrogate is admitted only as the lead of a pair (an unpaired one,
 * including one at the end of the string, is refused rather than rewritten),
 * and a lone low surrogate is refused, exactly as the pattern says.
 *
 * Every other control character the admission treats as content-free (a `Cc`
 * like U+0001, a `Cf` zero-width space or joiner, whitespace, punctuation, an
 * emoji) IS storable, and stays exactly that: a message that is not a
 * question, declined deterministically rather than refused as a body.
 */
export function isStorableText(text: string): boolean {
  return STORABLE_TEXT.test(text);
}

/**
 * The `message` field: the user's question, and storable text (see
 * `isStorableText`). The bounds run first, so an over-length body reports the
 * length issue first and `minLength`/`maxLength` stay in the published schema —
 * but `v.pipe` does not stop at a failed action, so the pattern runs on every
 * body that reaches the schema, over-length ones included: one linear match
 * over a string `JSON.parse` already produced.
 *
 * `v.regex` is deliberate, not a stylistic choice: `toOpenAPISchema` publishes
 * its `requirement.source` as the field's `pattern`, which is the one form
 * JSON Schema has for this rule. The schema a client reads and the parse the
 * route runs are then the same string.
 */
export const ChatMessageTextSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(CHAT_MESSAGE_MAX_LENGTH),
  v.regex(
    STORABLE_TEXT,
    `A message must be storable as text: no U+0000 and no unpaired surrogate (1 to ${CHAT_MESSAGE_MAX_LENGTH} characters).`,
  ),
  v.description(
    `The user's question (1 to ${CHAT_MESSAGE_MAX_LENGTH} characters), measured in UTF-16 code units on the raw string with no trim — so a body that would only trim to the ceiling is still rejected, and a whitespace-only body inside the ceiling is accepted. An over-length message, and a message the store cannot hold as text (U+0000, an unpaired surrogate), are rejected with 400 invalid_request before auth, the store or any pipeline stage runs; the other control characters are storable and reach the content-free admission, which declines them deterministically instead of refusing the body.`,
  ),
);

export const ChatRequestSchema = v.object({
  message: ChatMessageTextSchema,
  /** Existing chat session to append to; absent = create a new session. */
  sessionId: v.optional(ChatSessionIdSchema),
  /** UI language hint; the answer language (ID default). */
  language: v.optional(v.picklist(["id", "en"])),
});

export type ChatRequest = v.InferOutput<typeof ChatRequestSchema>;

/** The streamed meta event payload (sent as the first SSE `meta` frame). */
export const ChatMetaSchema = v.object({
  sessionId: v.pipe(v.string(), v.minLength(1)),
  messageId: v.pipe(v.string(), v.minLength(1)),
  traceId: v.pipe(v.string(), v.minLength(1)),
});

export type ChatMeta = v.InferOutput<typeof ChatMetaSchema>;

/** JSON error payload (validation/auth failures; successes stream instead). */
export const ChatErrorSchema = v.object({
  error: v.pipe(v.string(), v.minLength(1)),
});

export type ChatError = v.InferOutput<typeof ChatErrorSchema>;

/**
 * One resolved citation, derived SERVER-SIDE from the answer's persisted trace
 * (its `retrieval` chunk refs joined to the store's chunk rows): the client
 * never parses the answer text, so a label no retrieved chunk grounds cannot
 * reach the UI. `label` is the normalized inline citation span as the answer
 * wrote it (canonical `QS.`/`HR.` markers, grade suffix stripped). Grade values
 * travel as plain strings — the grade vocabulary is domain data.
 */
export const ChatCitationSchema = v.object({
  label: v.pipe(v.string(), v.minLength(1)),
  /** The Arabic original (canonical evidence layer); render RTL. */
  arabic: v.pipe(v.string(), v.minLength(1)),
  translation: v.optional(v.string()),
  grade: v.optional(v.pipe(v.string(), v.minLength(1))),
  machineTranslated: v.boolean(),
  source: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export type ChatCitation = v.InferOutput<typeof ChatCitationSchema>;

/**
 * The SSE `citations` frame payload, emitted after the answer's deltas and
 * before `done`, and with the same shape per assistant message on the
 * rehydration transcript. `citations` is the cited-and-grounded intersection;
 * `refusal` independently reports that the run's trace recorded a `refusal` event
 * — the answer is a Refusal or a Content-free decline — and never empties the list,
 * so a hybrid answer carries both. It is not a claim that the draft was replaced: a
 * pure refusal delivers the draft that already was the canonical sentence, and a
 * hybrid refusal delivers that draft with the product rules' copy appended; every
 * other refusal delivers product copy in the draft's place.
 * `dhaifWarning` tells the UI to render the deterministic warning card the
 * answer text carries.
 */
export const ChatCitationsFrameSchema = v.object({
  messageId: v.pipe(v.string(), v.minLength(1)),
  citations: v.array(ChatCitationSchema),
  refusal: v.boolean(),
  dhaifWarning: v.boolean(),
});

export type ChatCitationsFrame = v.InferOutput<typeof ChatCitationsFrameSchema>;

/**
 * One chunk reference in the user-facing Trace frame. The `technical` layer
 * carries the retrieval provenance verbatim from the persisted trace's
 * `retrieval` events (fused score, both channel ranks, the chunk's `origin`
 * label); the top "sources consulted" layer reuses the same shape with those
 * fields absent, so the panel's two layers read one contract.
 *
 * `source` is the cited work's display title, joined server-side by chunk id; a
 * missing row renders by id, never a fabricated title. `origin` is the trace's
 * opaque caller label — why a chunk no fused track produced is present.
 */
export const ChatTraceChunkSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  source: v.optional(v.pipe(v.string(), v.minLength(1))),
  score: v.optional(v.number()),
  rankDense: v.optional(v.number()),
  rankSparse: v.optional(v.number()),
  origin: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export type ChatTraceChunk = v.InferOutput<typeof ChatTraceChunkSchema>;

/**
 * The user-facing Trace payload: how an answer was built, in two layers, both
 * derived SERVER-SIDE from the answer's persisted trace (`answer_traces`) — the
 * client renders the frame, never reconstructing pipeline machinery. The top
 * `sources` layer lists the sources consulted in plain language (retrieval
 * order, deduplicated); `technical` carries the router intent, the sub-queries,
 * the scored chunks, and the model identities (opaque `modelId` strings from
 * `model_configs`). Emitted live as the SSE `trace` frame (after `citations`,
 * before `done`) and per assistant message on the rehydration transcript.
 */
export const ChatTraceFrameSchema = v.object({
  messageId: v.pipe(v.string(), v.minLength(1)),
  sources: v.array(ChatTraceChunkSchema),
  technical: v.object({
    intent: v.optional(v.pipe(v.string(), v.minLength(1))),
    confidence: v.optional(v.number()),
    /**
     * The routing decision: which source types the route selected and the
     * metadata filter record retrieval should run with, projected verbatim from
     * the persisted trace's `source_routing` event. Opaque strings — the domain
     * pack owns what a source type or a filter dimension means. An empty
     * `sources` list is a decision ("every source was in play"), never
     * "unknown". `relaxed` names the dimensions the run gave up on the trace's
     * `filter_relaxed` events, so the effective record is `filters − relaxed`;
     * a relaxed run would otherwise show a filter the search had already given
     * up. Shared with the trace variant's schema — only the drop list, which
     * lives on the retriever's events, is declared here.
     */
    routing: v.optional(
      v.object({
        ...sourceRoutingDetailSchema.entries,
        relaxed: v.optional(
          v.array(
            v.object({
              key: v.pipe(v.string(), v.minLength(1)),
              values: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
            }),
          ),
        ),
      }),
    ),
    subQueries: v.array(v.pipe(v.string(), v.minLength(1))),
    chunks: v.array(ChatTraceChunkSchema),
    /** Distinct model identities, in first-call order (opaque ids). */
    models: v.array(v.pipe(v.string(), v.minLength(1))),
  }),
});

export type ChatTraceFrame = v.InferOutput<typeof ChatTraceFrameSchema>;

/**
 * One rehydrated transcript message, mapped from the persisted chat rows. An
 * assistant message carries `citations` when its persisted trace resolves to a
 * frame, and the two-layer `trace` frame when its trace derives to one; a user
 * message (or an assistant message whose trace is missing) carries neither and
 * renders as plain text.
 */
export const ChatSessionMessageSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  role: v.picklist(["user", "assistant"]),
  content: v.string(),
  citations: v.optional(ChatCitationsFrameSchema),
  trace: v.optional(ChatTraceFrameSchema),
  /** Epoch milliseconds, as the store returns `created_at`. */
  createdAt: v.pipe(v.number(), v.integer()),
});

export type ChatSessionMessage = v.InferOutput<typeof ChatSessionMessageSchema>;

/** The `GET /v1/chat/sessions/:id/messages` response. */
export const ChatSessionMessagesSchema = v.object({
  sessionId: v.pipe(v.string(), v.minLength(1)),
  messages: v.array(ChatSessionMessageSchema),
  /**
   * True when the transcript was capped: the endpoint returns the newest tail
   * and omits older messages, so a client can tell it holds a tail.
   */
  truncated: v.boolean(),
});

export type ChatSessionMessages = v.InferOutput<typeof ChatSessionMessagesSchema>;
