import {
  allowRequest,
  corsGuard,
  createRequestContext,
  resolveRateLimiter,
} from "./";
import type { ApiEnv, RateLimiter } from "../env";
import { secureHeaders } from "hono/secure-headers";
import { trimTrailingSlash } from "hono/trailing-slash";
import type { Hono } from "hono";

export type MiddlewareOpts = { limiter?: RateLimiter; limit?: number };

/** Installs the cross-cutting middleware every route shares. */
export function applyMiddleware(api: Hono<ApiEnv>, opts?: MiddlewareOpts): void {
  api.use("*", trimTrailingSlash());
  api.use("*", secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "https://sentry.io"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  }));
  api.use("*", corsGuard);
  api.use("*", async (c, next) => {
    const id = c.req.header("X-Correlation-Id") ?? crypto.randomUUID();
    const ctx = createRequestContext(c.env.APP_ENV, id);
    c.set("correlationId", id);
    c.set("ctx", ctx);
    c.header("X-Correlation-Id", id);
    const ip = c.req.header("CF-Connecting-IP") ?? "local";
    // Injected limiter wins (tests); otherwise resolve from bindings:
    // Durable Objects when `RATE_LIMITER` is bound (global across isolates),
    // else the bounded in-memory fallback.
    if (!(await allowRequest(`ip:${ip}`, opts?.limiter ?? resolveRateLimiter(c.env), opts?.limit))) {
      return c.json({ error: "rate_limited" }, 429);
    }
    await next();
  });
}
