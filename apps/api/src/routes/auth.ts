import { AnonymousSessionSchema, DeletedUserSchema, type AnonymousSession } from "@app/contracts";
import { createLogger } from "@app/infra";
import { describeRoute, resolver } from "hono-openapi";
import { newRouter } from "../lib/guard";
import { authGuard, buildChatWiring, ChatConfigError } from "../lib/chat-wiring";

/**
 * Anonymous-session auth routes (ADR-0017, ticket #10): mint a session, and
 * let its owner erase themselves. Both go through the `RagStore` seam — no
 * direct database access, no vendor identity SDK (ADR-0017's whole point).
 *
 * `DELETE /v1/auth/me` is guarded: the Bearer token identifies the user, and
 * the cascade delete (sessions, chat sessions/messages, feedback, and the
 * user's answer traces — the ADR-0007 amendment) is one store call. Deleting
 * with an unauthenticated request is a 401, never a no-op.
 */

type AuthEnv = import("../env").ApiEnv["Bindings"] & Record<string, string | undefined>;

const ANONYMOUS_OPENAPI = describeRoute({
  summary: "Create an anonymous session",
  description:
    "Mints an anonymous user + 30-day Bearer session (ADR-0017). The token is returned exactly once; send it as `Authorization: Bearer <token>` on guarded routes.",
  responses: {
    200: {
      description: "The minted session",
      content: { "application/json": { schema: resolver(AnonymousSessionSchema) } },
    },
    429: {
      description: "Rate limited — the per-IP request budget for the window is exhausted",
      content: { "application/json": { schema: resolver(DeletedUserSchema) } },
    },
    503: {
      description: "Auth not configured — the DATABASE_URL binding is absent in this environment",
      content: { "application/json": { schema: resolver(DeletedUserSchema) } },
    },
  },
});

const DELETE_ME_OPENAPI = describeRoute({
  summary: "Delete the current anonymous user",
  description:
    "Erases the authenticated user and everything they own (sessions, chat sessions and messages, feedback, answer traces) via cascade (ADR-0017, ADR-0007 amendment).",
  responses: {
    200: {
      description: "The user and their data are gone",
      content: { "application/json": { schema: resolver(DeletedUserSchema) } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: resolver(DeletedUserSchema) } },
    },
    429: {
      description: "Rate limited — the per-IP request budget for the window is exhausted",
      content: { "application/json": { schema: resolver(DeletedUserSchema) } },
    },
    503: {
      description: "Auth not configured — the DATABASE_URL binding is absent in this environment",
      content: { "application/json": { schema: resolver(DeletedUserSchema) } },
    },
  },
});

export const authRoutes = newRouter()
  .post("/v1/auth/anonymous", ANONYMOUS_OPENAPI, async (c) => {
    const env = c.env as AuthEnv;
    const logger = createLogger({
      service: "api",
      route: "auth",
      correlationId: c.get("correlationId"),
    });
    let wiring;
    try {
      wiring = buildChatWiring(env);
    } catch (err) {
      // Same posture as /v1/chat: only a typed config failure is "not
      // configured"; anything else is a real fault and falls through.
      if (err instanceof ChatConfigError) {
        logger.warn("auth.not_configured", { missing: err.missing ?? "unknown" });
        return c.json({ error: "auth_not_configured" }, 503);
      }
      throw err;
    }
    const session = (await wiring.runStore(wiring.fullStore.createSession())) as AnonymousSession;
    logger.info("auth.anonymous_created", { sessionId: session.sessionId });
    return c.json(session satisfies AnonymousSession);
  })
  .delete("/v1/auth/me", DELETE_ME_OPENAPI, async (c) => {
    const env = c.env as AuthEnv;
    const logger = createLogger({
      service: "api",
      route: "auth",
      correlationId: c.get("correlationId"),
    });
    let wiring;
    try {
      wiring = buildChatWiring(env);
    } catch (err) {
      if (err instanceof ChatConfigError) {
        logger.warn("auth.not_configured", { missing: err.missing ?? "unknown" });
        return c.json({ error: "auth_not_configured" }, 503);
      }
      throw err;
    }
    const unauthorized = await authGuard(c, wiring.fullStore);
    if (unauthorized !== undefined) return unauthorized;
    const { userId } = c.get("authed");
    await wiring.runStore(wiring.fullStore.deleteUserCascade(userId));
    // No user id in the log line: the point of this endpoint is erasure.
    logger.info("auth.user_deleted");
    return c.json({ deleted: true } satisfies { deleted: true });
  });
