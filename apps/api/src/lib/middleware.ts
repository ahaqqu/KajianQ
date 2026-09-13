import {
  allowRequest,
  corsGuard,
  createRequestContext,
  installSecurityHeaders,
  resolveRateLimiter,
} from "./";
import { checkBypassHeader, RATE_BYPASS_HEADER } from "./rate-bypass";
import type { ApiEnv, RateLimiter } from "../env";
import { trimTrailingSlash } from "hono/trailing-slash";
import type { Hono } from "hono";

export type MiddlewareOpts = {
  limiter?: RateLimiter;
  limit?: number;
  /** Verifier key for bypass tokens; tests inject a generated keypair's key. */
  bypassPublicKeyB64?: string;
};

/** Installs the cross-cutting middleware every route shares. */
export function applyMiddleware(api: Hono<ApiEnv>, opts?: MiddlewareOpts): void {
  api.use("*", trimTrailingSlash());
  installSecurityHeaders(api);
  api.use("*", corsGuard);
  api.use("*", async (c, next) => {
    const id = c.req.header("X-Correlation-Id") ?? crypto.randomUUID();
    const ctx = createRequestContext(c.env.APP_ENV, id);
    c.set("correlationId", id);
    c.set("ctx", ctx);
    c.header("X-Correlation-Id", id);
    await next();
  });
  // Rate limiting is an API-surface policy (ADR-0041): only /v1/* is metered.
  // Static assets and the doc routes flow through unmetered — asset fetches
  // cannot carry credentials, and metering them steals the per-IP budget from
  // real chat calls while paying a Durable Object round-trip per asset.
  api.use("/v1/*", async (c, next) => {
    // A valid bypass token (Ed25519 JWT, ADR-0041) exempts the request from
    // metering — harness traffic (DAST/load tests), never user sessions: the
    // token grants nothing else. An invalid or absent token degrades to
    // ordinary metering; the reason is logged, never leaked to the response.
    const bypass = await checkBypassHeader(c.req.header(RATE_BYPASS_HEADER), opts);
    const ctx = c.get("ctx");
    if (bypass.ok) {
      ctx.logger.debug("rate.bypass", { subject: bypass.subject, path: c.req.path });
      return next();
    }
    if (bypass.reason !== "absent") {
      ctx.logger.warn("rate.bypass_rejected", { reason: bypass.reason });
    }
    const ip = c.req.header("CF-Connecting-IP") ?? "local";
    // Injected limiter wins (tests); otherwise resolve from bindings:
    // Durable Objects when `RATE_LIMITER` is bound (global across isolates),
    // else the bounded in-memory fallback.
    if (
      !(await allowRequest(`ip:${ip}`, opts?.limiter ?? resolveRateLimiter(c.env), opts?.limit))
    ) {
      return c.json({ error: "rate_limited" }, 429);
    }
    await next();
  });
}
