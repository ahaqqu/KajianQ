import type { SqlRunner } from "./rag-store-neon-errors";
import { neonCorpusMethods } from "./rag-store-neon-corpus";
import { neonSessionMethods } from "./rag-store-neon-session";
import { neonTraceMethods } from "./rag-store-neon-trace";

/**
 * Barrel over the Neon adapter's split method modules, so the composition
 * root (`rag-store-neon.ts`) stays within the agentic import cap. This is a
 * pure re-grouping — each module keeps its own concern (corpus / traces /
 * sessions), and no logic lives here.
 */
export function neonStoreMethods(sql: SqlRunner) {
  return {
    ...neonCorpusMethods(sql),
    ...neonTraceMethods(sql),
    ...neonSessionMethods(sql),
  };
}
