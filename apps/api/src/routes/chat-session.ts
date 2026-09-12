import {
  ChatErrorSchema,
  ChatSessionMessagesSchema,
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
 * GET /v1/chat/sessions/:id/messages (#11, ADR-0040): rehydrate a chat
 * session's full transcript. The UI restores it on reload, keyed by the
 * locally-stored session id (ADR-0017 anonymous sessions, low stakes by
 * design). Every assistant message's citation payload is derived from its
 * persisted answer trace — the same derivation the live `citations` frame
 * uses — so a rehydrated transcript can never show a citation the trace does
 * not ground.
 *
 * The wiring is store-only (no provider roles): a missing reviewer key must
 * not gate reading a transcript, exactly as it must not gate auth (thermo-
 * review A4). Ownership goes through the existing `getChatSessionUser` seam;
 * an unknown session and a foreign session are both 404, so the endpoint
 * leaks nothing about other users' sessions. 429 is documented for DAST.
 */

type SessionEnv = import("../env").ApiEnv["Bindings"] & Record<string, string | undefined>;

/** Transcript cap: a session is an anonymous conversation, not an archive. */
const MESSAGES_LIMIT = 200;

const SESSION_MESSAGES_OPENAPI = describeRoute({
  summary: "Rehydrate a chat session's messages",
  description:
    "Returns the session's transcript (oldest first). Assistant messages carry a `citations` payload derived from their persisted answer trace (ADR-0040); the client never parses answer text for citations.",
  responses: {
    200: {
      description: "The session's transcript with derived citation payloads",
      content: { "application/json": { schema: resolver(ChatSessionMessagesSchema) } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: resolver(ChatErrorSchema) } },
    },
    404: {
      description: "Session not found or not owned by the authenticated user",
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
    const owner = (await runStore(fullStore.getChatSessionUser(sessionId))) as string | null;
    if (owner !== userId) {
      // Same posture as the chat route's A6 check: unknown and foreign are
      // indistinguishable from the outside.
      return c.json({ error: "invalid_request" }, 404);
    }

    const rows = (await runStore(
      fullStore.getChatMessages(sessionId, { limit: MESSAGES_LIMIT }),
    )) as readonly ChatMessage[];

    const payload: ChatSessionMessages = await rehydrateTranscript({
      sessionId,
      rows,
      getTrace: async (traceId) =>
        (await runStore(fullStore.getAnswerTraceById(traceId))) as Trace | null,
      fetchChunks: chunkFetcher(fullStore, runStore),
      warn: (msg, fields) => logger.warn(msg, fields),
    });
    return c.json(payload);
  },
);
