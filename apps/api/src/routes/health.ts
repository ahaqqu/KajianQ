import { HealthResponseSchema, type HealthResponse } from "@app/contracts";
import { SCHEMA_VERSION } from "@app/local-first";
import { describeRoute, resolver } from "hono-openapi";
import { createRequestContext, type RequestContext } from "../lib/context";
import { newRouter } from "../lib/guard";

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
    const ctx = createRequestContext(c.env.APP_ENV, c.get("correlationId"));
    return c.json(buildHealth(ctx));
  },
);
