import * as v from "valibot";
import { sourceRoutingDetailSchema } from "./trace-source-routing";

/**
 * Chat API contracts (#8): the `/v1/chat` request/response surface. The
 * answer itself streams as SSE (`text/event-stream`); these schemas cover the
 * request body validation and the JSON error/meta payloads, shared by the
 * route (hono-openapi) and the eval harness client.
 */

/**
 * The chat message ceiling (#256): how long one question may be, in
 * characters. It is a hard COST bound, not a UX nicety — ADR-0041's rate
 * limiter caps request frequency, not request size, so without a ceiling a
 * client can stay inside the rate limit while multiplying what each accepted
 * question spends on the router, generator, and reviewer.
 *
 * 2,000 is ~21× the longest curated Golden Set question (93 characters; the
 * median is 55), so it is generous for a pasted passage plus a question, while
 * cutting the observed 20,000-character probe by an order of magnitude. The
 * exact value is an owner decision recorded in the issue: adjusting it is a
 * one-line edit here plus the boundary test that pins it.
 *
 * Length is measured in UTF-16 code units on the RAW string, before any trim
 * (nothing in the request path trims): the bound is on what the client
 * actually sends, so it cannot be met by whitespace a later stage would strip.
 * `ChatRequestSchema.message`'s description states the same rule on the API's
 * published surface, and the boundary tests pin both halves of it.
 */
export const CHAT_MESSAGE_MAX_LENGTH = 2000;

/**
 * A chat session id as a REQUEST value (#271): the format the store can
 * represent, and therefore the only format the API may accept.
 *
 * `chat_sessions.id` is a Postgres `uuid` column, and every id the API hands
 * out is minted by `crypto.randomUUID()` (`createChatSession`). A client-supplied
 * id that is not a UUID cannot name a session — the adapter's `${sessionId}::uuid`
 * cast raises before the ownership check can answer — so before this schema
 * existed the request passed validation and surfaced as a 500 `{"error":"internal"}`,
 * indistinguishable from a server fault. Validating here makes the refusal the
 * documented one, before any store call or pipeline stage: `400 invalid_request`
 * for the request body, the route's existing `404` for the rehydration path
 * param. It is a format check ONLY: a well-formed but unknown or foreign UUID
 * still answers exactly what it answered before, so it is no existence oracle
 * (`apps/api/src/routes/chat-session.ts` states the same posture).
 *
 * Deliberately NOT applied to the server-produced `sessionId` members
 * (`ChatMetaSchema`, `ChatSessionMessagesSchema`): those describe a value the
 * store minted or returned, and the `RagStore` seam types chat session ids as
 * opaque strings (`createChatSession(): Effect<string, StoreError>`) — a
 * response schema claiming a UUID shape would over-constrain the seam (the same
 * mismatch the trace-id note in `apps/api/src/routes/chat.ts` records) while
 * preventing no 500, because a response assertion is not a boundary.
 */
export const ChatSessionIdSchema = v.pipe(
  v.string(),
  v.uuid(),
  v.description(
    "The chat session's UUID (`chat_sessions.id`). A value that is not a UUID is rejected with 400 invalid_request before the store or any pipeline stage runs; a well-formed but unknown or foreign UUID answers the same 404 as a session that does not exist.",
  ),
);

/**
 * The predicate form of `ChatSessionIdSchema`, for the rehydration route's
 * `:id` guard: that route validates a path param (there is no body to parse)
 * and must read the SAME rule the body contract uses, never a second regex.
 */
export const isChatSessionId = (value: string): boolean => v.is(ChatSessionIdSchema, value);

export const ChatRequestSchema = v.object({
  message: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(CHAT_MESSAGE_MAX_LENGTH),
    v.description(
      `The user's question (1 to ${CHAT_MESSAGE_MAX_LENGTH} characters), measured in UTF-16 code units on the raw string with no trim — so a body that would only trim to the ceiling is still rejected, and a whitespace-only body inside the ceiling is accepted. An over-length message is rejected with 400 invalid_request before any pipeline stage runs.`,
    ),
  ),
  /**
   * Existing chat session to append to; absent = create a new session. The
   * format is the session-id contract (#271) — see `ChatSessionIdSchema`.
   */
  sessionId: v.optional(ChatSessionIdSchema),
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
 * `citations` payload of the session-rehydration endpoint. The two fields are
 * independent projections of the one persisted trace: `citations` is the
 * cited-and-grounded intersection, and `refusal` reports the refusal decision
 * the trace records — it is not implied by the list, and it never empties it,
 * so a hybrid answer (a grounded partial answer that runs into the canonical
 * refusal sentence) carries both (#436). The weak-grade flag tells the UI to
 * render the deterministic warning card the answer text carries (the flag
 * keeps the product's CONTEXT.md term as its wire name — see the boundary
 * rule's file-scoped exemption).
 */
export const ChatCitationsFrameSchema = v.object({
  messageId: v.pipe(v.string(), v.minLength(1)),
  citations: v.array(ChatCitationSchema),
  refusal: v.boolean(),
  dhaifWarning: v.boolean(),
});

export type ChatCitationsFrame = v.InferOutput<typeof ChatCitationsFrameSchema>;

/**
 * One chunk reference in the user-facing Trace frame (#12, ADR-0007). The
 * `technical` layer carries the retrieval provenance verbatim from the
 * persisted trace's `retrieval` events (fused score + both channel ranks +
 * the chunk's `origin` label); the top "sources consulted" layer reuses the
 * same shape with those provenance fields simply absent, so the panel's two
 * layers read one contract.
 *
 * `source` is the cited work's display title, joined server-side from the
 * store by the chunk id — the client never resolves display data itself. A
 * chunk whose row (or title) is missing renders by id instead: honest
 * provenance, never a fabricated title.
 *
 * `origin` is the same opaque caller label the persisted trace carries
 * (`ChunkRef.origin`, ADR-0045), projected verbatim: it answers "why is this
 * chunk here" for a chunk no fused track produced. The surah-scope
 * expansion's verses carry no score and no channel rank, so without the
 * label the panel shows them as scoreless sources with no stated reason.
 * Optional and absent by default: fused hits have no label, and traces
 * persisted before the field existed must keep rendering — the panel omits
 * what the trace does not carry, never invents it.
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
 * The user-facing Trace payload (#12, ADR-0007): how an answer was built, in
 * two layers, both derived SERVER-SIDE from the answer's persisted trace
 * (`answer_traces`) — the client renders the frame, it never reconstructs
 * pipeline machinery from event soup. The top layer (`sources`) lists the
 * sources consulted in plain language (retrieval order, deduplicated); the
 * `technical` layer, one tap deeper, carries the router intent, the
 * sub-queries, the retrieved chunks with their scores, and the model
 * identities (opaque `modelId` strings resolved from `model_configs` at
 * wiring time — ADR-0009: no vendor or model names in code).
 *
 * Emitted live as the SSE `trace` frame (after `citations`, before `done`)
 * and attached per-message to the rehydration transcript, the same dual path
 * the citations frame uses (ADR-0040).
 */
export const ChatTraceFrameSchema = v.object({
  messageId: v.pipe(v.string(), v.minLength(1)),
  /** Top layer: the sources consulted, plain language, retrieval order. */
  sources: v.array(ChatTraceChunkSchema),
  technical: v.object({
    /** The router's classified intent, when the trace recorded one. */
    intent: v.optional(v.pipe(v.string(), v.minLength(1))),
    confidence: v.optional(v.number()),
    /**
     * The routing decision (#15): which source types the route selected and the
     * metadata filter record it decided retrieval should run with, projected
     * verbatim from the persisted trace's `source_routing` event. Opaque
     * strings — the domain pack owns what a source type or a filter dimension
     * means; the frame neither names nor interprets one. An empty `sources`
     * list is a decision ("every source was in play") and is rendered as such,
     * never as "unknown". `relaxed` names the dimensions the run actually gave
     * up on the trace's `filter_relaxed` events, so `filters` reads as the
     * route's decision and the effective record is `filters − relaxed` — for a
     * relaxed run the panel would otherwise show a filter the search had
     * already given up. Optional and absent by default: traces persisted before
     * the field existed must keep rendering.
     *
     * The shared half is the trace variant's own schema (one owner, one shape
     * for the routing decision); only the drop list, which exists on the
     * retriever's events rather than on the routing event, is declared here.
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
    /** Distinct model identities, in first-call order (ADR-0009 opaque ids). */
    models: v.array(v.pipe(v.string(), v.minLength(1))),
  }),
});

export type ChatTraceFrame = v.InferOutput<typeof ChatTraceFrameSchema>;

/**
 * One rehydrated transcript message (#11): the rehydration endpoint maps the
 * persisted chat rows onto this shape. An assistant message carries
 * `citations` when its persisted trace resolves to a frame; a user message
 * (or an assistant message whose trace is missing) carries none — the UI
 * renders it as plain text with no citation affordances. The same assistant
 * messages carry the two-layer `trace` frame (#12) when their trace derives
 * to one.
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
