import {
  createLogger,
  type AdminAccessRoute,
  type AdminAccessSummary,
  type Logger,
} from "@app/infra";
import type { Context } from "hono";
import { adminGuard } from "./admin-auth";
import { buildStoreWiring, wiringOr503, type StoreWiring } from "./chat-wiring";
import type { ApiEnv } from "../env";

/**
 * The one entry every admin read takes before it may serve anything (ADR-0064).
 *
 * Order matters and is the invariant:
 *
 *  1. **authenticate first** — an unauthenticated request must not learn whether
 *     the store is configured, nor whether its query was valid, so the 503 wiring
 *     posture and the 400 validation answer are both behind the credential check;
 *  2. **resolve what will be logged** — the caller's own resolver runs here, so the
 *     read's 400/404 verdict and its summary are both computed behind the guard and a
 *     read cannot be served with a summary computed somewhere else;
 *  3. **log before serving** — a read that cannot be recorded is not served. The
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

  const resolved = resolve();
  if ("refuse" in resolved) return c.json({ error: resolved.refuse.error }, resolved.refuse.status);

  const logger = createLogger({
    service: "api",
    route: "admin",
    correlationId: c.get("correlationId"),
  });
  const wiring = wiringOr503(() => buildStoreWiring(c.env), logger, "admin_not_configured");
  if ("response" in wiring) return wiring.response;

  const { fullStore, runStore } = wiring.wiring;
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
