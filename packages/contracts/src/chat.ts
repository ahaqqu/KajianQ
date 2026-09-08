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