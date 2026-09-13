import {
  FeedbackRequestSchema,
  type ChatCitationsFrame,
  type FeedbackAnchor,
  type FeedbackRequest,
  type Trace,
} from "@app/contracts";
import { describeRoute, resolver } from "hono-openapi";
import * as v from "valibot";
import { deriveCitationsFrame } from "./chat-citations";
import {
  chunksByIdOrEmpty,
  chunkFetcher,
  traceChunkIds,
  type CitationChunkSource,
  type Warn,
} from "./chat-trace";

// The route needs the same fetcher the derivation binds; re-exported here so
// the route imports one lib module (same pattern as the chat-wiring hub).
export { chunkFetcher };

/**
 * The feedback route's OpenAPI description, body-parse helper, and anchor
 * validation (#13), split from the route file so the handler stays under the
 * agentic caps. Consumes the shared @app/contracts feedback schemas — one
 * source of truth for handler, validation, and doc.
 *
 * The invariant this module owns: **a flag may only anchor an element the
 * persisted trace actually grounds.** Chunk anchors must be trace chunk refs
 * (the Trace panel's rows); citation/translation/grade anchors must be labels
 * the server-side citations derivation emits for that answer (the chips and
 * their passage sheet). A flag for an element the trace does not ground is
 * malformed — the same "never without provenance" posture the citations frame
 * itself takes (ADR-0040) — so a report is always actionable.
 */
export const FEEDBACK_OPENAPI = describeRoute({
  summary: "Submit anonymous feedback (thumb or trace-anchored flag)",
  requestBody: {
    required: true,
    content: {
      "application/json": {
        // Pre-resolved (see chat-openapi.ts): hono-openapi only resolves
        // schemas in `responses` positions.
        schema: await resolver(FeedbackRequestSchema)
          .toOpenAPISchema()
          .then((r) => r.schema),
      },
    },
  },
  responses: {
    200: {
      description: "The stored feedback row, with its anchor echoed",
      content: { "application/json": { schema: resolver(v.any()) } },
    },
    400: {
      description: "Invalid request body (invalid_json or invalid_request)",
      content: { "application/json": { schema: resolver(v.any()) } },
    },
    401: {
      description: "Unauthorized (anonymous Bearer session required)",
      content: { "application/json": { schema: resolver(v.any()) } },
    },
    404: {
      description: "No answer trace for the message, or not the caller's answer",
      content: { "application/json": { schema: resolver(v.any()) } },
    },
    422: {
      description: "Malformed anchor — the flagged element is not grounded by the persisted trace",
      content: { "application/json": { schema: resolver(v.any()) } },
    },
    429: {
      description: "Rate limited — the per-IP request budget for the window is exhausted",
      content: { "application/json": { schema: resolver(v.any()) } },
    },
    503: {
      description: "Feedback not configured — the DATABASE_URL binding is absent",
      content: { "application/json": { schema: resolver(v.any()) } },
    },
  },
});

/**
 * Validate the /v1/feedback body against the shared contract (same posture as
 * parseChatRequest): JSON-parse and schema failures are distinct, diagnostic
 * codes, logged server-side, never collapsed into one generic 400.
 */
export async function parseFeedbackRequest(
  req: Request,
  log?: { warn(msg: string, fields?: Record<string, string | number | boolean | null>): void },
): Promise<
  | { success: true; output: FeedbackRequest }
  | { success: false; error: "invalid_json" | "invalid_request"; detail?: string }
> {
  const raw = await req.text().catch(() => null);
  if (raw === null) {
    log?.warn("feedback.body_unreadable");
    return { success: false, error: "invalid_json" };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    log?.warn("feedback.body_invalid_json", {
      detail: err instanceof Error ? err.message.slice(0, 120) : "parse error",
    });
    return { success: false, error: "invalid_json" };
  }
  const parsed = v.safeParse(FeedbackRequestSchema, body);
  if (!parsed.success) {
    const detail = parsed.issues
      .map((i) => `${i.path?.join(".") ?? "<body>"}: ${i.message}`)
      .join("; ");
    log?.warn("feedback.body_invalid", { detail: detail.slice(0, 200) });
    return { success: false, error: "invalid_request", detail: detail.slice(0, 200) };
  }
  return { success: true, output: parsed.output };
}

/**
 * Derive the citations frame a flag's label must appear in — the exact
 * derivation the live `citations` frame uses, so the server validates the
 * anchor against the elements the client actually saw. Null when the answer's
 * message row is gone (nothing honest to validate against).
 */
export async function deriveFeedbackCitations(input: {
  messageId: string;
  trace: Trace;
  getMessage: () => Promise<{ content: string } | null>;
  fetchChunks: CitationChunkSource;
  warn: Warn;
}): Promise<ChatCitationsFrame | null> {
  try {
    const message = await input.getMessage();
    if (message === null) return null;
    const ids = traceChunkIds(input.trace);
    const chunksById = await chunksByIdOrEmpty({
      ids,
      fetchChunks: input.fetchChunks,
      warn: input.warn,
      warnKey: "feedback.anchor.chunk_lookup_failed",
      warnFields: { messageId: input.messageId },
    });
    return deriveCitationsFrame({
      trace: input.trace,
      messageId: input.messageId,
      answerText: message.content,
      chunksById,
    });
  } catch (err) {
    input.warn("feedback.anchor.derive_failed", {
      messageId: input.messageId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Is the anchor grounded? A chunk id must be a trace retrieval ref; a
 * citation/translation/grade label must be a label of the derived citations
 * frame — and translation/grade additionally require the cited sheet to
 * actually carry that layer (flagging a translation that does not exist is
 * itself malformed).
 */
export function validateFeedbackAnchor(input: {
  anchor: FeedbackAnchor;
  trace: Trace;
  citations: ChatCitationsFrame | null;
}): boolean {
  const { anchor, trace, citations } = input;
  if (anchor.type === "chunk") return traceChunkIds(trace).includes(anchor.id);
  if (citations === null) return false;
  const citation = citations.citations.find((c) => c.label === anchor.id);
  if (citation === undefined) return false;
  if (anchor.type === "translation") return citation.translation !== undefined;
  if (anchor.type === "grade") return citation.grade !== undefined;
  return true; // "citation"
}
