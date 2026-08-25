import { HealthResponseSchema, type HealthResponse } from "@app/contracts";
import { describeRoute, resolver } from "hono-openapi";
import type { RequestContext } from "../env";
import { newRouter } from "../lib/guard";

/**
 * Placeholder persistence-schema version. The local-first sync package that
 * used to own it is removed; #4 owns the real Neon schema version. Health
 * keeps reporting a monotonically increasing integer so clients can feature-
 * check once persistence lands.
 */
const SCHEMA_VERSION = 1;

export function buildHealth(ctx: RequestContext): HealthResponse {
  const body: HealthResponse = {
    status: "ok",
    env: ctx.envName,
    schemaVersion: SCHEMA_VERSION,
    message: "Hello World",
  };
  ctx.logger.info("health.ok", { schemaVersion: body.schemaVersion });
  return body;
}

export const healthRoutes = newRouter().get(
  "/v1/health",
  describeRoute({
    summary: "Health",
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: resolver(HealthResponseSchema) } },
      },
    },
  }),
  (c) => {
    const ctx = c.get("ctx");
    return c.json(buildHealth(ctx));
  },
);
