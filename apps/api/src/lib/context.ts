import { createLogger, type Logger } from "@app/infra";
import type { AppEnvName } from "../env";

export type RequestContext = {
  logger: Logger;
  envName: AppEnvName;
  correlationId: string;
};

export function createRequestContext(
  envName: AppEnvName,
  correlationId: string,
): RequestContext {
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
