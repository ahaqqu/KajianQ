import * as Sentry from "@sentry/cloudflare";
import { createLogger } from "@app/infra";
import {
  PipelineAbortedError,
  ProviderError,
  type ProviderErrorKind,
  StageError,
} from "@app/rag-core/interop";
import type { Context } from "hono";
import type { ApiEnv } from "../env";

/**
 * The HTTP statuses the typed engine failure channel maps onto (ADR-0027
 * phase 3). Both are upstream-fault statuses: the engine's error kinds
 * describe the vendor's view of the call, so no kind can honestly be a
 * client's 400 — client-origin failures are valibot validation failures on
 * the route, not `ProviderError`s.
 */
type EngineStatus = 429 | 502;

/** Truthful body per status, total over `EngineStatus` (compiler-proven). */
const ENGINE_BODIES: { [S in EngineStatus]: string } = {
  429: "rate_limited",
  502: "upstream",
};

/**
 * The vendor's `Retry-After` isn't plumbed through the `Provider` seam (the
 * engine never sees vendor headers), so the mapped 429 carries a conservative
 * fixed back-off for well-behaved clients.
 */
const RATE_LIMIT_RETRY_AFTER_SECONDS = "30";

/**
 * Expected operational conditions — vendor throttle, transport, server, and
 * vendor-rejected-call failures the client sees as mapped statuses. They are
 * logged (`request.upstream_failure` warn), never captured as Sentry
 * exceptions: a vendor outage must not become one exception per request.
 * `exhausted` (the whole fallback chain failed) still captures — every
 * candidate is down or misconfigured and needs eyes.
 */
const LOG_ONLY_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  "rate_limited",
  "bad_request",
  "transport",
  "server",
]);

/** The request's logger, built once per dispatch from the request context. */
function requestLogger(c: Context<ApiEnv>) {
  const ctx = c.get("ctx");
  return (
    ctx?.logger ??
    createLogger({
      service: "api",
      env: c.env.APP_ENV ?? "development",
      correlationId: c.get("correlationId"),
    })
  );
}

/**
 * Typed error dispatch. Handler throws land here; unexpected errors are
 * captured and logged with the request's correlation id.
 */
export function onError(err: unknown, c: Context<ApiEnv>): Response {
  const logger = requestLogger(c);
  // A client-aborted run is an expected condition, not a defect: quiet log,
  // no Sentry capture, and a status that says the client is gone (nginx's
  // established 499 semantics) so it is never a 5xx.
  if (err instanceof PipelineAbortedError) {
    logger.info("request.client_abort", { path: c.req.path });
    // Raw Response because 499 (nginx's "client closed request") is outside
    // Hono's typed status union — but the honest status for a client that is
    // already gone.
    return new Response(JSON.stringify({ error: "aborted" }), {
      status: 499,
      headers: { "content-type": "application/json; charset=UTF-8" },
    });
  }
  const engine = providerCauseOf(err);
  // Typed engine failures (ADR-0027) map onto honest statuses before the
  // generic 500 — a vendor outage is a 502, not an internal error.
  if (engine) {
    const status = engineErrorStatus(err);
    if (!LOG_ONLY_KINDS.has(engine.kind)) Sentry.captureException(err);
    logger.warn("request.upstream_failure", {
      path: c.req.path,
      status,
      kind: engine.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    const headers = status === 429 ? { "Retry-After": RATE_LIMIT_RETRY_AFTER_SECONDS } : undefined;
    return c.json({ error: ENGINE_BODIES[status] }, status, headers);
  }
  Sentry.captureException(err);
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
 * - `rate_limited` → 429: the vendor throttled us; the client may retry
 *   later (`Retry-After` carried on the response).
 * - every other kind → 502: the upstream provider is at fault. That
 *   includes `bad_request` — the vendor rejecting OUR call (malformed or
 *   unauthorized, e.g. our bad API key) is vendor-side misconfiguration,
 *   never evidence of a client mistake, so it must not surface as a 400.
 */
export function engineErrorStatus(err: unknown): EngineStatus | undefined {
  const provider = providerCauseOf(err);
  if (!provider) return undefined;
  return provider.kind === "rate_limited" ? 429 : 502;
}

/** Unwrap `StageError` (stage + cause) down to its `ProviderError`, if any. */
function providerCauseOf(err: unknown): ProviderError | undefined {
  if (err instanceof StageError) {
    return err.cause instanceof ProviderError ? err.cause : undefined;
  }
  if (err instanceof ProviderError) return err;
  return undefined;
}
