import {
  createLogger,
  type AdminAccessRoute,
  type AdminAccessSummary,
  type Logger,
} from "@app/infra";
import type { Context } from "hono";
import { adminGuard, adminUnauthorized, type AdminSessionClaims } from "./admin-auth";
import { buildStoreWiring, wiringOr503, type StoreWiring } from "./chat-wiring";
import type { ApiEnv } from "../env";

/**
 * The one entry every admin read takes before it may serve anything (ADR-0064).
 *
 * Order matters and is the invariant:
 *
 *  1. **authenticate first** — an unauthenticated request must not learn whether
 *     the store is configured, nor whether its query was valid, so every other
 *     answer is behind the credential check;
 *  2. **the session must be live** — a token whose session id is on the revocation
 *     denylist is the same miss as an expired or forged one, and it is refused
 *     before anything is logged or read. A store that cannot answer that question
 *     fails closed: an unverifiable session is not served;
 *  3. **resolve what will be logged** — the caller's own resolver runs here, so the
 *     read's 400/404 verdict and its summary are both computed behind the guard and a
 *     read cannot be served with a summary computed somewhere else;
 *  4. **log before serving** — a read that cannot be recorded is not served. The
 *     access log is the accountability evidence for reading chat content, so a
 *     failed write fails closed with a 503 that carries no content.
 */
export type AdminReadContext<T> = {
  actor: string;
  store: StoreWiring;
  /** What the resolver computed from the request — the parsed query, the validated row
   * id — so the route reads on with the value that was narrowed behind the guard and
   * never re-derives it. */
  read: T;
  /** The request's structured logger, for the read's own degradation warnings and for
   * a read the route refuses because the data behind it is not current. */
  log: Logger;
  /** The warning shorthand over `log`, kept because most reads only warn. */
  warn: (msg: string, fields?: Record<string, string | number | boolean | null>) => void;
};

/** What a read's resolver returns: its summary plus the value the route reads on with, or
 * the refusal it answers instead (a 400 for a malformed query, a 404 for an id the column
 * cannot hold). One union, so the route narrows once and no branch is unreachable — and the
 * refusal is a status and an error, never a Response, so a resolver cannot answer the request
 * before the log record is written. */
export type AdminReadPlan<T> =
  | { summary: AdminAccessSummary; read: T }
  | { refuse: { status: 400 | 404; error: string } };

export async function withAdminRead<T>(
  c: Context<ApiEnv>,
  route: AdminAccessRoute,
  resolve: () => AdminReadPlan<T>,
): Promise<AdminReadContext<T> | Response> {
  const identity = await adminGuard(c, c.env);
  if (identity instanceof Response) return identity;

  const logger = createLogger({
    service: "api",
    route: "admin",
    correlationId: c.get("correlationId"),
  });
  const wiring = wiringOr503(() => buildStoreWiring(c.env), logger, "admin_not_configured");
  if ("response" in wiring) return wiring.response;
  const { fullStore, runStore } = wiring.wiring;

  // The session is authenticated; now it must still be live. Asking the denylist is
  // the only check that can distinguish a signed-out token from a live one, so a store
  // that cannot answer fails closed — a revoked session must not become readable
  // because the check errored.
  let revoked: boolean;
  try {
    revoked = await runStore(fullStore.isAdminSessionRevoked(identity.jti));
  } catch (err) {
    logger.error("admin.session_revocation_check_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "admin_unavailable" }, 503);
  }
  if (revoked) return adminUnauthorized(c);

  const resolved = resolve();
  if ("refuse" in resolved) return c.json({ error: resolved.refuse.error }, resolved.refuse.status);

  try {
    await runStore(
      fullStore.recordAdminAccess({
        actor: identity.actor,
        route,
        summary: resolved.summary,
      }),
    );
  } catch (err) {
    // No content is served on a failed audit write. The error is logged by its
    // message only: the summary holds no content in the first place.
    logger.error("admin.access_log_failed", {
      route,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "admin_unavailable" }, 503);
  }
  return {
    actor: identity.actor,
    store: wiring.wiring,
    read: resolved.read,
    log: logger,
    warn: (msg, fields) => logger.warn(msg, fields),
  };
}

/**
 * Is a live, non-revoked admin session present? Drives the shell's `authenticated`
 * state; a false answer is not an error, it is the login form. Fail-closed by
 * construction: a session whose revocation state cannot be read is reported as a
 * miss rather than as live, and no content read follows from this answer.
 *
 * Both session-lifecycle helpers take the request alone and read the token's
 * environment and the denylist's store from that one source (`c.env`), so a helper
 * cannot verify against one environment and ask another environment's store.
 */
export async function adminSessionActive(c: Context<ApiEnv>): Promise<boolean> {
  const identity = await liveAdminSession(c);
  return identity !== null;
}

/**
 * Revoke the session the request presents, if it names a live one. Returns false
 * ONLY when a live token's revocation could not be written: the caller must then
 * answer a failure rather than a success, because a 204 would report a sign-out that
 * did not happen. An absent, expired, forged or already-revoked token has nothing to
 * revoke and reads as a completed sign-out.
 */
export async function revokePresentedSession(c: Context<ApiEnv>): Promise<boolean> {
  // `adminGuard` is the module's one cookie reader; its 401 for a miss is discarded
  // because a logout with no valid token is still a successful logout.
  const identity = await adminGuard(c, c.env);
  if (identity instanceof Response) return true;
  try {
    const { fullStore, runStore } = buildStoreWiring(c.env);
    await runStore(
      fullStore.revokeAdminSession({ jti: identity.jti, expiresAt: identity.expiresAt }),
    );
    return true;
  } catch (err) {
    c.get("ctx")?.logger.error("admin.session_revocation_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Verify the token, then ask the denylist. `null` covers every miss, including a
 * revocation store that cannot answer. */
async function liveAdminSession(c: Context<ApiEnv>): Promise<AdminSessionClaims | null> {
  const identity = await adminGuard(c, c.env);
  if (identity instanceof Response) return null;
  try {
    const { fullStore, runStore } = buildStoreWiring(c.env);
    const revoked = await runStore(fullStore.isAdminSessionRevoked(identity.jti));
    if (revoked) return null;
    return identity;
  } catch (err) {
    c.get("ctx")?.logger.warn("admin.session_revocation_unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
