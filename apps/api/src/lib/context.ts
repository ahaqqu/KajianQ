import { createLogger, type Logger } from "@app/infra";
import { resolveEnvName, type AppEnvName } from "../env";

export type RequestContext = {
  logger: Logger;
  envName: AppEnvName;
  correlationId: string;
};

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
