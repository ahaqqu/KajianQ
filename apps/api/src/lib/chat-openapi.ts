import { ChatRequestSchema, describeIssue } from "@app/contracts";
import { describeRoute, resolver } from "hono-openapi";
import * as v from "valibot";
import { BODY_MAX_BYTES, readJsonBody, type RequestRefusal, type Warn } from "./body";

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
    400: {
      description:
        "Invalid request body — invalid_json (not JSON), invalid_encoding (not UTF-8), " +
        "or invalid_request (failed the body schema)",
      content: { "application/json": { schema: resolver(v.any()) } },
    },
    413: {
      description: `Request body over the ${BODY_MAX_BYTES}-byte ceiling — payload_too_large`,
      content: { "application/json": { schema: resolver(v.any()) } },
    },
    415: {
      description: "Missing or non-JSON Content-Type on the body — unsupported_media_type",
      content: { "application/json": { schema: resolver(v.any()) } },
    },
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
 * (media type, size, UTF-8, JSON syntax) is `readJsonBody`'s; this function
 * adds the chat schema and keeps JSON-parse, encoding, and schema failures
 * distinct, diagnostic codes, all logged server-side with the correlation id.
 */
export async function parseChatRequest(
  req: Request,
  log?: Warn,
): Promise<{ success: true; output: import("@app/contracts").ChatRequest } | RequestRefusal> {
  const body = await readJsonBody(req, "chat", log);
  if (!body.success) return body;
  const parsed = v.safeParse(ChatRequestSchema, body.value);
  if (!parsed.success) {
    const detail = parsed.issues.map(describeIssue).join("; ");
    log?.warn("chat.body_invalid", { detail: detail.slice(0, 200) });
    return { success: false, error: "invalid_request", status: 400, detail: detail.slice(0, 200) };
  }
  return { success: true, output: parsed.output as import("@app/contracts").ChatRequest };
}
