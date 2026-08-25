import * as Sentry from "@sentry/cloudflare";
import { createLogger } from "@app/infra";
import type { Context } from "hono";
import type { ApiEnv } from "../env";

/**
 * Typed error dispatch. Handler throws land here; unexpected errors are
 * captured and logged with the request's correlation id.
 */
export function onError(err: unknown, c: Context<ApiEnv>): Response {
  Sentry.captureException(err);
  const ctx = c.get("ctx");
  const logger = ctx?.logger ?? createLogger({
    service: "api",
    env: c.env.APP_ENV ?? "development",
    correlationId: c.get("correlationId"),
  });
  logger.error("request.unhandled", {
    path: c.req.path,
    error: err instanceof Error ? err.message : String(err),
  });
  return c.json({ error: "internal" }, 500);
}
