import * as Sentry from "@sentry/cloudflare";
import { createLogger } from "@app/infra";
import { ProviderError, StageError } from "@app/rag-core/interop";
import type { Context } from "hono";
import type { ApiEnv } from "../env";

/**
 * Typed error dispatch. Handler throws land here; unexpected errors are
 * captured and logged with the request's correlation id.
 */
export function onError(err: unknown, c: Context<ApiEnv>): Response {
  Sentry.captureException(err);
  // Typed engine failures (ADR-0027) map onto honest statuses before the
  // generic 500 — a vendor outage is a 502, not an internal error.
  const engineStatus = engineErrorStatus(err);
  if (engineStatus !== undefined) {
    const ctx2 = c.get("ctx");
    (ctx2?.logger ?? createLogger({
      service: "api",
      env: (c.env as { APP_ENV?: string } | undefined)?.APP_ENV ?? "development",
      correlationId: c.get("correlationId"),
    })).warn("request.upstream_failure", {
      path: c.req.path,
      status: engineStatus,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "upstream" }, engineStatus as 400 | 429 | 502);
  }
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

/**
 * Map a failed engine call onto the HTTP status the client should see
 * (ADR-0027 phase 3: the typed `E` channel becomes HTTP semantics). Routes
 * call this when an engine bridge rejects; `onError` uses it as the fast
 * path for typed engine errors before falling back to the generic 500.
 *
 * - `rate_limited` → 429: the vendor throttled us; the client may retry later.
 * - `bad_request` → 400: the request was malformed or misconfigured upstream.
 * - transport / server / exhausted → 502: the upstream provider is at fault.
 */
export function engineErrorStatus(err: unknown): number | undefined {
  const provider = providerCauseOf(err);
  if (!provider) return undefined;
  if (provider.kind === "rate_limited") return 429;
  if (provider.kind === "bad_request") return 400;
  return 502;
}

/** Unwrap `StageError` (stage + cause) down to its `ProviderError`, if any. */
function providerCauseOf(err: unknown): ProviderError | undefined {
  if (err instanceof StageError) {
    return err.cause instanceof ProviderError ? err.cause : undefined;
  }
  if (err instanceof ProviderError) return err;
  return undefined;
}
