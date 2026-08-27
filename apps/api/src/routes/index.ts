import { serveAssets } from "@app/hardening";
import type { Hono } from "hono";
import type { ApiEnv } from "../env";
import { registerDocRoutes } from "./docs";
import { healthRoutes } from "./health";

/**
 * Mounts every route module, then the doc routes that introspect them.
 * The foundation shell exposes only health + docs; guarded product routes
 * (chat, feedback) arrive with the RagStore-backed pipeline in later tickets.
 */
export function registerRoutes(api: Hono<ApiEnv>): void {
  api.route("/", healthRoutes);
  registerDocRoutes(api);

  // SPA catch-all: non-API paths serve the static assets through the Hono
  // stack, so security headers, CORS, and rate limiting cover the SPA too.
  // API namespaces get a machine-readable JSON 404 instead of the SPA.
  api.all("*", (c) => serveAssets(c.req.raw, c.env.ASSETS));
}
