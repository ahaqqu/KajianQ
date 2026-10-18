import {
  AnonymousSessionSchema,
  AuthErrorSchema,
  DeletedUserSchema,
  type AnonymousSession,
} from "@app/contracts";
import { createLogger } from "@app/infra";
import { describeRoute, resolver } from "hono-openapi";
import { newRouter } from "../lib/guard";
import { authGuard, buildStoreWiring, wiringOr503 } from "../lib/chat-wiring";

/**
 * Anonymous-session auth routes (ADR-0017): mint a session, and
 * let its owner erase themselves. Both go through the `RagStore` seam — no
 * direct database access, no vendor identity SDK (ADR-0017's whole point).
 *
 * The wiring is store-only: these routes never touch the
 * chat pipeline, so a missing LLM role cannot gate token minting or the
 * self-deletion erasure right.
 *
 * `DELETE /v1/auth/me` is guarded: the Bearer token identifies the user, and
 * the erasure of the user's whole subtree (sessions, chat sessions/messages,
 * feedback, and the user's answer traces — ADR-0007) is one transactional store
 * call whose success means the rows are gone; an erasure that leaves a row is an
 * error response, never `{ deleted: true }`. Deleting with an unauthenticated
 * request is a 401, never a no-op.
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
      content: { "application/json": { schema: resolver(AuthErrorSchema) } },
    },
    503: {
      description: "Auth not configured — the DATABASE_URL binding is absent in this environment",
      content: { "application/json": { schema: resolver(AuthErrorSchema) } },
    },
  },
});

const DELETE_ME_OPENAPI = describeRoute({
  summary: "Delete the current anonymous user",
  description:
    "Erases the authenticated user and their whole subtree — sessions, chat sessions and messages, feedback, answer traces — in one transaction (ADR-0017, ADR-0007). One call erases all of it, and a `200 {deleted: true}` means the rows are gone: the erasure verifies every table of the subtree inside the transaction and answers an error instead if any row survives. A failed erasure rolls back, so the subtree is never half-erased. The call is idempotent, but a repeat cannot re-authenticate once the user's sessions are gone — that is a `401`, not a success.",
  responses: {
    200: {
      description: "The user and their whole subtree are gone",
      content: { "application/json": { schema: resolver(DeletedUserSchema) } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: resolver(AuthErrorSchema) } },
    },
    429: {
      description: "Rate limited — the per-IP request budget for the window is exhausted",
      content: { "application/json": { schema: resolver(AuthErrorSchema) } },
    },
    500: {
      description:
        "The erasure did not complete — the transaction rolled back and the user's rows are untouched, so nothing was reported deleted",
      content: { "application/json": { schema: resolver(AuthErrorSchema) } },
    },
    503: {
      description: "Auth not configured — the DATABASE_URL binding is absent in this environment",
      content: { "application/json": { schema: resolver(AuthErrorSchema) } },
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
    // Auth needs the store, not the chat pipeline — a missing reviewer key
    // must not take down session minting (or the eval harness's token mint).
    // The typed-failure→503 posture is shared with the chat route.
    const resolved = wiringOr503(() => buildStoreWiring(env), logger, "auth_not_configured");
    if ("response" in resolved) return resolved.response;
    const { fullStore, runStore } = resolved.wiring;
    const session = (await runStore(fullStore.createSession())) as AnonymousSession;
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
    const resolved = wiringOr503(() => buildStoreWiring(env), logger, "auth_not_configured");
    if ("response" in resolved) return resolved.response;
    const { fullStore, runStore } = resolved.wiring;
    const unauthorized = await authGuard(c, fullStore);
    if (unauthorized !== undefined) return unauthorized;
    const { userId } = c.get("authed");
    await runStore(fullStore.deleteUserCascade(userId));
    // No user id in the log line: the point of this endpoint is erasure.
    logger.info("auth.user_deleted");
    return c.json({ deleted: true } satisfies { deleted: true });
  });
