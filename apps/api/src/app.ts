import { Hono } from "hono";
import type { ApiEnv } from "./env";
import { onError } from "./lib/errors";
import { applyMiddleware, type MiddlewareOpts } from "./lib/middleware";
import { registerRoutes } from "./routes";

/**
 * Composition root only: middleware, typed error dispatch, routes. Each route
 * module owns its hono-openapi definition, so handler, validation, and
 * OpenAPI doc share one source of truth.
 *
 * `opts.limiter` lets tests inject an isolated `RateLimiter` instead of
 * exhausting the module-level global limiter, and `opts.limit` lets tests use
 * a small budget instead of the magic 120/min production default; when either
 * is omitted, production uses the `globalLimiter` and `120` from
 * `rate-limit-mw.ts`.
 */
export function createApi(opts?: MiddlewareOpts) {
  const api = new Hono<ApiEnv>();
  applyMiddleware(api, opts);
  api.onError(onError);
  registerRoutes(api);
  return api;
}
