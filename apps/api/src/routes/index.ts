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
}
