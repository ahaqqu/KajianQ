import { serveAssets } from "@app/hardening";
import type { Hono } from "hono";
import type { ApiEnv } from "../env";
import { ADMIN_API_PREFIX } from "../lib/admin-paths";
import { adminListRoutes } from "./admin-list";
import { adminSessionRoutes } from "./admin-session";
import { adminTraceRoutes } from "./admin-trace";
import { authRoutes } from "./auth";
import { chatRoutes } from "./chat";
import { chatSessionRoutes } from "./chat-session";
import { feedbackRoutes } from "./feedback";
import { registerDocRoutes } from "./docs";
import { healthRoutes } from "./health";

/**
 * Mounts every route module, then the doc routes that introspect them.
 *
 * The admin surface (ADR-0064) is mounted at its own prefix under the public API
 * namespace, so the deployment's existing `/v1` proxy carries it, but it is
 * deliberately **absent from the public OpenAPI document** — `registerDocRoutes`
 * excludes it — so no client generated from `/openapi.json` can see it exists. Each
 * admin router registers prefix-relative paths, so this is the one place the
 * namespace is spelled; a router mounted elsewhere would fall outside the admin
 * middleware's meter and cookie scope. Its routes are also served a machine-readable
 * JSON 404 when unknown, never the SPA.
 */
export function registerRoutes(api: Hono<ApiEnv>): void {
  api.route("/", healthRoutes);
  api.route("/", authRoutes);
  api.route("/", chatRoutes);
  api.route("/", chatSessionRoutes);
  api.route("/", feedbackRoutes);
  api.route(ADMIN_API_PREFIX, adminSessionRoutes);
  api.route(ADMIN_API_PREFIX, adminListRoutes);
  api.route(ADMIN_API_PREFIX, adminTraceRoutes);
  registerDocRoutes(api);

  // SPA catch-all: non-API paths serve the static assets through the Hono
  // stack, so security headers and CORS cover the SPA too; rate limiting
  // meters /v1 only (ADR-0041).
  // API paths get a machine-readable JSON 404 instead of the SPA.
  api.all("*", (c) => serveAssets(c.req.raw, c.env.ASSETS, { apiPrefixes: ["/v1/"] }));
}
