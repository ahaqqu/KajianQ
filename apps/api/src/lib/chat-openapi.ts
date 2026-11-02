import { ChatErrorSchema, ChatRequestSchema, type ChatRequest } from "@app/contracts";
import { describeRoute, resolver } from "hono-openapi";
import * as v from "valibot";
import { bodyRejectionResponses } from "./body-openapi";
import { parseJsonBody, type ParsedBody, type Warn } from "./body-parse";

/**
 * The chat route's OpenAPI description and body-parse helper, split from
 * `chat-wiring.ts` so the wiring module stays under the agentic import cap.
 * Both consume the shared @app/contracts chat schemas — one source of truth
 * for handler, validation, and doc.
 */
export const CHAT_OPENAPI_DESCRIPTION = describeRoute({
  summary: "Chat",
  requestBody: {
    required: true,
    content: {
      "application/json": {
        // Pre-resolved here (not left as a `resolver(...)`): hono-openapi only
        // resolves schemas in `responses` positions — a resolver left in a
        // spec-level `requestBody` serializes as the opaque `{vendor: ...}`
        // object, so consumers (schemathesis) see no body schema and generate
        // body-less requests the route answers 400.
        schema: await resolver(ChatRequestSchema)
          .toOpenAPISchema()
          .then((r) => r.schema),
      },
    },
  },
  responses: {
    200: {
      description: "SSE stream of answer deltas",
      content: { "text/event-stream": { schema: resolver(v.any()) } },
    },
    ...bodyRejectionResponses(ChatErrorSchema),
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: resolver(v.any()) } },
    },
    404: {
      description: "Session not found or not owned by the authenticated user",
      content: { "application/json": { schema: resolver(v.any()) } },
    },
    502: {
      description: "Upstream provider failure (typed engine error channel)",
      content: { "application/json": { schema: resolver(v.any()) } },
    },
    503: {
      description: "Chat not configured — the DATABASE_URL binding is absent in this environment",
      content: { "application/json": { schema: resolver(v.any()) } },
    },
    429: {
      description: "Rate limited — the per-IP request budget for the window is exhausted",
      content: { "application/json": { schema: resolver(v.any()) } },
    },
  },
});

/**
 * Validate the /v1/chat body against the shared contract. The body boundary
 * (media type, size, UTF-8, JSON syntax) is `readJsonBody`'s; `parseJsonBody`
 * adds the chat schema and keeps JSON-parse, encoding, and schema failures
 * distinct, diagnostic codes, all logged server-side with the correlation id.
 */
export async function parseChatRequest(req: Request, log?: Warn): Promise<ParsedBody<ChatRequest>> {
  return parseJsonBody(req, { route: "chat", schema: ChatRequestSchema, log });
}
