import { ChatRequestSchema } from "@app/contracts";
import { describeRoute, resolver } from "hono-openapi";
import * as v from "valibot";

/**
 * The chat route's OpenAPI description and body-parse helper, split from
 * `chat-wiring.ts` so the wiring module stays under the agentic import cap.
 * Both consume the shared @app/contracts chat schemas — one source of truth
 * for handler, validation, and doc.
 */
export const CHAT_OPENAPI_DESCRIPTION = describeRoute({
  summary: "Chat",
  responses: {
    200: {
      description: "SSE stream of answer deltas",
      content: { "text/event-stream": { schema: resolver(v.any()) } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: resolver(v.any()) } },
    },
  },
});

/** Validate the /v1/chat body against the shared contract; null on bad JSON. */
export async function parseChatRequest(
  req: Request,
): Promise<{ success: true; output: import("@app/contracts").ChatRequest } | { success: false }> {
  const body = await req.json().catch(() => null);
  const parsed = v.safeParse(ChatRequestSchema, body);
  return parsed.success
    ? { success: true, output: parsed.output as import("@app/contracts").ChatRequest }
    : { success: false };
}
