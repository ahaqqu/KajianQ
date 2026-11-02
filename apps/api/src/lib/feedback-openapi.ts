import {
  describeIssue,
  FeedbackErrorSchema,
  FeedbackRequestSchema,
  FeedbackResponseSchema,
  type FeedbackRequest,
} from "@app/contracts";
import { describeRoute, resolver } from "hono-openapi";
import * as v from "valibot";
import { BODY_MAX_BYTES, readJsonBody, type RequestRefusal, type Warn } from "./body";

/**
 * The feedback route's OpenAPI description and body-parse helper, split from
 * `feedback.ts` so the anchor-validation module stays under the agentic import
 * cap. Consumes the shared @app/contracts feedback schemas — one source of
 * truth for handler, validation, and doc.
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
      description:
        "The stored feedback row, echoing its canonical message id and anchor; " +
        "`id`'s repeat semantics are stated once in the `id` field description " +
        "(canonical: `FeedbackResponseSchema.id`)",
      content: { "application/json": { schema: resolver(FeedbackResponseSchema) } },
    },
    400: {
      description:
        "Invalid request body — invalid_json (not JSON), invalid_encoding (not UTF-8), " +
        "or invalid_request (failed the body schema)",
      content: { "application/json": { schema: resolver(FeedbackErrorSchema) } },
    },
    401: {
      description: "Unauthorized (anonymous Bearer session required)",
      content: { "application/json": { schema: resolver(FeedbackErrorSchema) } },
    },
    404: {
      description: "No answer trace for the message, or not the caller's answer",
      content: { "application/json": { schema: resolver(FeedbackErrorSchema) } },
    },
    413: {
      description: `Request body over the ${BODY_MAX_BYTES}-byte ceiling — payload_too_large`,
      content: { "application/json": { schema: resolver(FeedbackErrorSchema) } },
    },
    415: {
      description: "Missing or non-JSON Content-Type on the body — unsupported_media_type",
      content: { "application/json": { schema: resolver(FeedbackErrorSchema) } },
    },
    422: {
      description: "Malformed anchor — the flagged element is not grounded by the persisted trace",
      content: { "application/json": { schema: resolver(FeedbackErrorSchema) } },
    },
    429: {
      description: "Rate limited — the per-IP request budget for the window is exhausted",
      content: { "application/json": { schema: resolver(FeedbackErrorSchema) } },
    },
    503: {
      description:
        "Feedback not configured (DATABASE_URL binding absent), or the trace-side anchor " +
        "derivation degraded (answer text reclaimed, chunk lookup failed) — anchor_unavailable",
      content: { "application/json": { schema: resolver(FeedbackErrorSchema) } },
    },
  },
});

/**
 * Validate the /v1/feedback body against the shared contract. The body
 * boundary (media type, size, UTF-8, JSON syntax) is `readJsonBody`'s; this
 * function adds the feedback schema and keeps JSON-parse, encoding, and schema
 * failures distinct, diagnostic codes, logged server-side, never collapsed
 * into one generic 400.
 */
export async function parseFeedbackRequest(
  req: Request,
  log?: Warn,
): Promise<{ success: true; output: FeedbackRequest } | RequestRefusal> {
  const body = await readJsonBody(req, "feedback", log);
  if (!body.success) return body;
  const parsed = v.safeParse(FeedbackRequestSchema, body.value);
  if (!parsed.success) {
    const detail = parsed.issues.map(describeIssue).join("; ");
    log?.warn("feedback.body_invalid", { detail: detail.slice(0, 200) });
    return { success: false, error: "invalid_request", status: 400, detail: detail.slice(0, 200) };
  }
  return { success: true, output: parsed.output };
}
