import { createLogger } from "@app/infra";
import { resolveEnvName, type RequestContext } from "../env";

export type { RequestContext } from "../env";

export function createRequestContext(
  appEnv: string | undefined,
  correlationId: string,
): RequestContext {
  const envName = resolveEnvName(appEnv);
  return {
    envName,
    correlationId,
    logger: createLogger({
      service: "api",
      env: envName,
      correlationId,
    }),
  };
}
