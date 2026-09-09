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

/**
 * Validate the /v1/chat body against the shared contract (thermo-review C3):
 * JSON-parse failures and schema failures return distinct, diagnostic error
 * codes — both logged server-side with the correlation id, neither silently
 * collapsed into one generic 400.
 */
export async function parseChatRequest(
  req: Request,
  log?: { warn(msg: string, fields?: Record<string, string | number | boolean | null>): void },
): Promise<
  | { success: true; output: import("@app/contracts").ChatRequest }
  | { success: false; error: "invalid_json" | "invalid_request"; detail?: string }
> {
  const raw = await req.text().catch(() => null);
  if (raw === null) {
    log?.warn("chat.body_unreadable");
    return { success: false, error: "invalid_json" };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    log?.warn("chat.body_invalid_json", {
      detail: err instanceof Error ? err.message.slice(0, 120) : "parse error",
    });
    return { success: false, error: "invalid_json" };
  }
  const parsed = v.safeParse(ChatRequestSchema, body);
  if (!parsed.success) {
    const detail = parsed.issues.map((i) => `${i.path?.join(".") ?? "<body>"}: ${i.message}`).join("; ");
    log?.warn("chat.body_invalid", { detail: detail.slice(0, 200) });
    return { success: false, error: "invalid_request", detail: detail.slice(0, 200) };
  }
  return { success: true, output: parsed.output as import("@app/contracts").ChatRequest };
}
