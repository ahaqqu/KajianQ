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

  // SPA catch-all: every non-API path serves the static assets (which are
  // themselves a React/Vue SPA and handle client-side routing). API 404s are
  // returned as JSON so API consumers get a machine-readable error.
  api.all("*", async (c) => {
    if (c.req.path.startsWith("/v1/")) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.env.ASSETS.fetch(c.req.raw);
  });
}
