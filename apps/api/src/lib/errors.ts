import * as Sentry from "@sentry/cloudflare";
import { createLogger } from "@app/infra";
import type { Context } from "hono";
import type { ApiEnv } from "../env";
import { DbUnboundError } from "./db";

/**
 * Typed error dispatch (replaces the old `err.message === "db_unbound"` string
 * match in index.ts, which Hono's default onError made unreachable). Handler
 * throws land here; unexpected errors are captured and logged with the
 * request's correlation id.
 */
export function onError(err: unknown, c: Context<ApiEnv>): Response {
  Sentry.captureException(err);
  const logger = createLogger({
    service: "api",
    env: c.env.APP_ENV ?? "development",
    correlationId: c.get("correlationId"),
  });
  if (err instanceof DbUnboundError) {
    logger.error("request.db_unbound", { path: c.req.path });
    return c.json({ error: "db_unbound" }, 503);
  }
  logger.error("request.unhandled", {
    path: c.req.path,
    error: err instanceof Error ? err.message : String(err),
  });
  return c.json({ error: "internal" }, 500);
}
