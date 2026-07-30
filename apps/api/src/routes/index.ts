import type { Hono } from "hono";
import type { ApiEnv } from "../env";
import { authRoutes } from "./auth";
import { registerDocRoutes } from "./docs";
import { healthRoutes } from "./health";
import { notesRoutes } from "./notes";
import { syncRoutes } from "./sync";

/** Mounts every route module, then the doc routes that introspect them. */
export function registerRoutes(api: Hono<ApiEnv>): void {
  api.route("/", healthRoutes);
  api.route("/", authRoutes);
  api.route("/", notesRoutes);
  api.route("/", syncRoutes);
  registerDocRoutes(api);
}
