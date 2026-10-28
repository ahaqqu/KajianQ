import { createLogger, type AdminAccessRoute, type AdminAccessSummary } from "@app/infra";
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
 *  2. **resolve what will be logged** — the caller's own summarizer runs here, so a
 *     read cannot be served with a summary computed somewhere else;
 *  3. **log before serving** — a read that cannot be recorded is not served. The
 *     access log is the accountability evidence for reading chat content, so a
 *     failed write fails closed with a 503 that carries no content.
 */
export type AdminReadContext = {
  actor: string;
  store: StoreWiring;
  /** The request's structured logger, for the read's own degradation warnings. */
  warn: (msg: string, fields?: Record<string, string | number | boolean | null>) => void;
};

/** What a read's summarizer returns: the record's summary, or its own refusal. */
export type AdminReadSummary = { summary: AdminAccessSummary } | { response: Response };

export async function withAdminRead(
  c: Context<ApiEnv>,
  route: AdminAccessRoute,
  resolve: () => AdminReadSummary,
): Promise<AdminReadContext | Response> {
  const identity = await adminGuard(c, c.env);
  if (identity instanceof Response) return identity;

  const resolved = resolve();
  if ("response" in resolved) return resolved.response;

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
    warn: (msg, fields) => logger.warn(msg, fields),
  };
}
