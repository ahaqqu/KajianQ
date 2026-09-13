import { serveAssets } from "@app/hardening";
import type { Hono } from "hono";
import type { ApiEnv } from "../env";
import { authRoutes } from "./auth";
import { chatRoutes } from "./chat";
import { chatSessionRoutes } from "./chat-session";
import { registerDocRoutes } from "./docs";
import { healthRoutes } from "./health";

/**
 * Mounts every route module, then the doc routes that introspect them.
 * Guarded product routes arrive with their backing ticket: chat (#8) and the
 * anonymous-session auth routes (ADR-0017, #10) are mounted; feedback/admin
 * land later.
 */
export function registerRoutes(api: Hono<ApiEnv>): void {
  api.route("/", healthRoutes);
  api.route("/", authRoutes);
  api.route("/", chatRoutes);
  api.route("/", chatSessionRoutes);
  registerDocRoutes(api);

  // SPA catch-all: non-API paths serve the static assets through the Hono
  // stack, so security headers, CORS, and rate limiting cover the SPA too.
  // API namespaces get a machine-readable JSON 404 instead of the SPA.
  api.all("*", (c) => serveAssets(c.req.raw, c.env.ASSETS));
}
