import * as v from "valibot";

/**
 * Chat API contracts (#8): the `/v1/chat` request/response surface. The
 * answer itself streams as SSE (`text/event-stream`); these schemas cover the
 * request body validation and the JSON error/meta payloads, shared by the
 * route (hono-openapi) and the eval harness client.
 */

export const ChatRequestSchema = v.object({
  message: v.pipe(v.string(), v.minLength(1)),
  /** Existing chat session to append to; absent = create a new session. */
  sessionId: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** UI language hint; the answer language (ID default, per product scope). */
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
 * One resolved citation (#11, ADR-0040). The payload is derived SERVER-SIDE
 * from the answer's persisted trace (its `retrieval` chunk refs joined to the
 * store's chunk rows) — the client never parses the answer text to decide
 * what is a citation, so a citation label that no retrieved chunk grounds can
 * never reach the UI (the same invariant the deterministic citation gate
 * enforces on the answer itself).
 *
 * `label` is the normalized inline citation span as the answer wrote it
 * (canonical `QS.`/`HR.` markers, grade suffix stripped); the rest is the
 * cited chunk's display data. Grade values travel as plain strings — the
 * corpus's grade vocabulary is domain data, not part of the engine contract.
 */
export const ChatCitationSchema = v.object({
  label: v.pipe(v.string(), v.minLength(1)),
  /** The Arabic original (canonical evidence layer, ADR-0013); render RTL. */
  arabic: v.pipe(v.string(), v.minLength(1)),
  /** The translation layer the answer quoted from, when the chunk has one. */
  translation: v.optional(v.string()),
  /** The source's grade badge value, when the source carries one. */
  grade: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** True when the displayed translation is machine-made (ADR-0006 label). */
  machineTranslated: v.boolean(),
  /** Collection/work reference string for display (the parent doc's title). */
  source: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export type ChatCitation = v.InferOutput<typeof ChatCitationSchema>;

/**
 * The SSE `citations` frame payload (ADR-0040), emitted after the answer's
 * deltas and before `done` — and, with the same shape, the per-message
 * `citations` payload of the session-rehydration endpoint. `refusal` marks a
 * refused answer (empty citation list); the weak-grade flag tells the UI to render
 * the deterministic warning card the answer text carries (the flag keeps
 * the product's CONTEXT.md term as its wire name — see the boundary rule's
 * file-scoped exemption).
 */
export const ChatCitationsFrameSchema = v.object({
  messageId: v.pipe(v.string(), v.minLength(1)),
  citations: v.array(ChatCitationSchema),
  refusal: v.boolean(),
  dhaifWarning: v.boolean(),
});

export type ChatCitationsFrame = v.InferOutput<typeof ChatCitationsFrameSchema>;

/**
 * One rehydrated transcript message (#11): the rehydration endpoint maps the
 * persisted chat rows onto this shape. An assistant message carries
 * `citations` when its persisted trace resolves to a frame; a user message
 * (or an assistant message whose trace is missing) carries none — the UI
 * renders it as plain text with no citation affordances.
 */
export const ChatSessionMessageSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  role: v.picklist(["user", "assistant"]),
  content: v.string(),
  citations: v.optional(ChatCitationsFrameSchema),
  /** Epoch milliseconds, as the store returns `created_at`. */
  createdAt: v.pipe(v.number(), v.integer()),
});

export type ChatSessionMessage = v.InferOutput<typeof ChatSessionMessageSchema>;

/** The `GET /v1/chat/sessions/:id/messages` response (#11, ADR-0040). */
export const ChatSessionMessagesSchema = v.object({
  sessionId: v.pipe(v.string(), v.minLength(1)),
  messages: v.array(ChatSessionMessageSchema),
  /**
   * True when the transcript was capped: the endpoint returns the newest
   * tail and older messages are not included (thermo-review A4 — the client
   * must be able to tell it is looking at a tail, never silently).
   */
  truncated: v.boolean(),
});

export type ChatSessionMessages = v.InferOutput<typeof ChatSessionMessagesSchema>;
