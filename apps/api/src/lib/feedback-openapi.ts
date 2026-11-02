import {
  FeedbackErrorSchema,
  FeedbackRequestSchema,
  FeedbackResponseSchema,
  type FeedbackRequest,
} from "@app/contracts";
import { describeRoute, resolver } from "hono-openapi";
import { bodyRejectionResponses } from "./body-openapi";
import { parseJsonBody, type ParsedBody, type Warn } from "./body-parse";

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
    ...bodyRejectionResponses(FeedbackErrorSchema),
    401: {
      description: "Unauthorized (anonymous Bearer session required)",
      content: { "application/json": { schema: resolver(FeedbackErrorSchema) } },
    },
    404: {
      description: "No answer trace for the message, or not the caller's answer",
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
 * Validate the /v1/feedback body against the shared contract. The body boundary
 * (media type, size, UTF-8, JSON syntax) is `readJsonBody`'s; `parseJsonBody`
 * adds the feedback schema and keeps JSON-parse, encoding, and schema failures
 * distinct, diagnostic codes, logged server-side, never collapsed into one
 * generic 400.
 */
export async function parseFeedbackRequest(
  req: Request,
  log?: Warn,
): Promise<ParsedBody<FeedbackRequest>> {
  return parseJsonBody(req, { route: "feedback", schema: FeedbackRequestSchema, log });
}
