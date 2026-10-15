import { serveAssets } from "@app/hardening";
import type { Hono } from "hono";
import type { ApiEnv } from "../env";
import { authRoutes } from "./auth";
import { chatRoutes } from "./chat";
import { chatSessionRoutes } from "./chat-session";
import { feedbackRoutes } from "./feedback";
import { registerDocRoutes } from "./docs";
import { healthRoutes } from "./health";

/**
 * Mounts every route module, then the doc routes that introspect them. Admin
 * routes are not mounted yet.
 */
export function registerRoutes(api: Hono<ApiEnv>): void {
  api.route("/", healthRoutes);
  api.route("/", authRoutes);
  api.route("/", chatRoutes);
  api.route("/", chatSessionRoutes);
  api.route("/", feedbackRoutes);
  registerDocRoutes(api);

  // SPA catch-all: non-API paths serve the static assets through the Hono
  // stack, so security headers and CORS cover the SPA too; rate limiting
  // meters /v1 only (ADR-0041).
  // API namespaces get a machine-readable JSON 404 instead of the SPA.
  api.all("*", (c) => serveAssets(c.req.raw, c.env.ASSETS));
}
