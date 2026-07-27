import { HealthResponseSchema, type HealthResponse } from "@app/shared-zod";
import { SCHEMA_VERSION } from "@app/sync-protocol";
import type { RequestContext } from "../lib/context";

export function buildHealth(ctx: RequestContext): HealthResponse {
  const body: HealthResponse = {
    status: "ok",
    env: ctx.envName,
    schemaVersion: SCHEMA_VERSION,
    message: "Hello World",
  };
  const parsed = HealthResponseSchema.parse(body);
  ctx.logger.info("health.ok", { schemaVersion: parsed.schemaVersion });
  return parsed;
}
