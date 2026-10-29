import type { SqlRunner } from "./rag-store-postgres-errors";
import { postgresModelConfigMethods } from "./rag-store-postgres-model-config";
import { postgresNarratorMethods } from "./rag-store-postgres-narrator";
import { postgresStoreMethods } from "./rag-store-postgres-parts";

/**
 * The adapter's non-admin method groups behind one factory. The split keeps each
 * file inside the agentic import cap while the composition root names one call; the
 * admin half is composed separately because its access-log rules read as their own
 * concern.
 */
export function postgresMethods(sql: SqlRunner) {
  return {
    ...postgresStoreMethods(sql),
    ...postgresModelConfigMethods(sql),
    ...postgresNarratorMethods(sql),
  };
}
