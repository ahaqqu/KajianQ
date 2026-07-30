import { CLIENT_VERSION, SCHEMA_VERSION } from "@app/local-first";
import { openAPIRouteHandler } from "hono-openapi";
import type { Hono } from "hono";
import type { ApiEnv } from "../lib/guard";

/**
 * Serves the generated OpenAPI doc. Must be registered after all route
 * modules: the handler walks the root app's route table on first request.
 */
export function registerDocRoutes(api: Hono<ApiEnv>): void {
  api.get(
    "/openapi.json",
    openAPIRouteHandler(api, {
      documentation: {
        info: { title: "Agentic Template API", version: "1.0.0" },
      },
    }),
  );
  api.get("/docs", (c) =>
    c.html(
      `<!doctype html><html lang="en"><body><h1>API</h1><a href="/openapi.json">OpenAPI</a> · schema ${SCHEMA_VERSION} · client ${CLIENT_VERSION}</body></html>`,
    ),
  );
}
