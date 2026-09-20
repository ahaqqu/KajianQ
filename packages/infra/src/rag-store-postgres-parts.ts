import type { SqlRunner } from "./rag-store-postgres-errors";
import { postgresCorpusMethods } from "./rag-store-postgres-corpus";
import { postgresEvalMethods } from "./rag-store-postgres-eval";
import { postgresSessionMethods } from "./rag-store-postgres-session";
import { postgresTraceMethods } from "./rag-store-postgres-trace";

/**
 * Barrel over the Postgres adapter's split method modules, so the composition
 * root (`rag-store-postgres.ts`) stays within the agentic import cap. This is a
 * pure re-grouping — each module keeps its own concern (corpus / eval /
 * traces+feedback / sessions), and no logic lives here.
 */
export function postgresStoreMethods(sql: SqlRunner) {
  return {
    ...postgresCorpusMethods(sql),
    ...postgresEvalMethods(sql),
    ...postgresTraceMethods(sql),
    ...postgresSessionMethods(sql),
  };
}
