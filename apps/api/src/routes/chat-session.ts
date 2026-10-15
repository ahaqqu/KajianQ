import {
  ChatErrorSchema,
  ChatSessionMessagesSchema,
  isChatSessionId,
  type ChatSessionMessages,
  type Trace,
} from "@app/contracts";
import { createLogger, type ChatMessage } from "@app/infra";
import { describeRoute, resolver } from "hono-openapi";
import { newRouter } from "../lib/guard";
import {
  authGuard,
  buildStoreWiring,
  chunkFetcher,
  rehydrateTranscript,
  wiringOr503,
} from "../lib/chat-wiring";

/**
 * GET /v1/chat/sessions/:id/messages: rehydrate a chat session's transcript. Each
 * assistant message's citation payload is derived from its persisted answer trace —
 * the same derivation the live `citations` frame uses — so a rehydrated transcript
 * never shows a citation the trace does not ground.
 *
 * The wiring is store-only, and an unknown, foreign, or unrepresentable session id
 * is one and the same 404.
 */

type SessionEnv = import("../env").ApiEnv["Bindings"] & Record<string, string | undefined>;

/** Transcript cap: a session is a conversation, not an archive. One row past the cap
 * is read to DETECT truncation, so the client learns it is seeing a tail. */
const MESSAGES_LIMIT = 200;

const SESSION_MESSAGES_OPENAPI = describeRoute({
  summary: "Rehydrate a chat session's messages",
  description:
    "Returns the session's transcript (oldest first). Assistant messages carry a `citations` payload derived from their persisted answer trace (ADR-0040) plus the two-layer `trace` payload of the Trace panel (#12, ADR-0007) — both derived server-side from the same trace; the client never parses answer text for citations nor reconstructs pipeline machinery.",
  responses: {
    200: {
      description: "The session's transcript with derived citation and trace payloads",
      content: { "application/json": { schema: resolver(ChatSessionMessagesSchema) } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: resolver(ChatErrorSchema) } },
    },
    404: {
      description:
        "Session not found or not owned by the authenticated user — or an `id` that is not a UUID, which cannot name a session (`chat_sessions.id` is a uuid)",
      content: { "application/json": { schema: resolver(ChatErrorSchema) } },
    },
    429: {
      description: "Rate limited — the per-IP request budget for the window is exhausted",
      content: { "application/json": { schema: resolver(ChatErrorSchema) } },
    },
    503: {
      description: "Chat not configured — the DATABASE_URL binding is absent in this environment",
      content: { "application/json": { schema: resolver(ChatErrorSchema) } },
    },
  },
});

export const chatSessionRoutes = newRouter().get(
  "/v1/chat/sessions/:id/messages",
  SESSION_MESSAGES_OPENAPI,
  async (c): Promise<Response> => {
    const env = c.env as SessionEnv;
    const logger = createLogger({
      service: "api",
      route: "chat-session",
      correlationId: c.get("correlationId"),
    });
    const resolved = wiringOr503(() => buildStoreWiring(env), logger, "chat_not_configured");
    if ("response" in resolved) return resolved.response;
    const { fullStore, runStore } = resolved.wiring;

    const unauthorized = await authGuard(c, fullStore);
    if (unauthorized !== undefined) return unauthorized;
    const { userId } = c.get("authed");

    const sessionId = c.req.param("id");
    // The id must be a value `chat_sessions.id` (uuid) can hold before the store sees
    // it — the adapter's `${sessionId}::uuid` cast throws on anything else. A malformed
    // id leaves through the same documented 404 as an unknown or foreign one; auth runs
    // first, so the guard is not an auth bypass.
    if (!isChatSessionId(sessionId)) {
      return c.json({ error: "invalid_request" }, 404);
    }
    const owner = (await runStore(fullStore.getChatSessionUser(sessionId))) as string | null;
    if (owner !== userId) {
      // Unknown and foreign are indistinguishable from the outside.
      return c.json({ error: "invalid_request" }, 404);
    }

    // One row past the cap answers "is there more?" without a count query; the
    // store returns the newest tail oldest-first, so the extra row is the oldest.
    const fetched = (await runStore(
      fullStore.getChatMessages(sessionId, { limit: MESSAGES_LIMIT + 1 }),
    )) as readonly ChatMessage[];
    const truncated = fetched.length > MESSAGES_LIMIT;
    const rows = truncated ? fetched.slice(1) : fetched;

    const payload: ChatSessionMessages = await rehydrateTranscript({
      sessionId,
      rows,
      truncated,
      getTrace: async (traceId) =>
        (await runStore(fullStore.getAnswerTraceById(traceId))) as Trace | null,
      fetchChunks: chunkFetcher(fullStore, runStore),
      warn: (msg, fields) => logger.warn(msg, fields),
    });
    return c.json(payload);
  },
);
