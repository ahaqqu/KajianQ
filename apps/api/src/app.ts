import { Hono } from "hono";
import type { ApiEnv } from "./env";
import { onError } from "./lib/errors";
import { applyMiddleware } from "./lib/middleware";
import { registerRoutes } from "./routes";

/**
 * Composition root only: middleware, typed error dispatch, routes. Each route
 * module owns its hono-openapi definition, so handler, validation, and
 * OpenAPI doc share one source of truth.
 */
export function createApi() {
  const api = new Hono<ApiEnv>();
  applyMiddleware(api);
  api.onError(onError);
  registerRoutes(api);
  return api;
}
