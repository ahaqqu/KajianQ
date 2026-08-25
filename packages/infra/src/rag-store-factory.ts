import type { RagStore } from "./rag-store";
import { createNeonRagStore, type SqlRunner } from "./rag-store-neon";
import type { NeonRagStoreOptions } from "./rag-store-neon-logging";

/**
 * Persistence backends that have a RagStore adapter in this package. The
 * union grows only when a second adapter actually lands (issue #63: do not
 * pre-provision 'sqlite'/'memory' stubs — pluggability is served by the
 * interface, not by speculative adapters).
 */
export type RagStoreProvider = "neon";

/**
 * Provider-selection factory over the RagStore adapters (ADR-0008 seam,
 * issue #63 item 2). Callers name a backend by role instead of importing a
 * concrete adapter constructor, so swapping persistence stays a wiring edit.
 *
 * `sql` is the driver query handle for the chosen backend (structurally the
 * Neon runner today); adapter options are forwarded verbatim. The exhaustive
 * switch makes adding a provider to the union without implementing it a
 * compile-time failure at this switch, not a runtime surprise.
 */
export function createRagStore(
  provider: RagStoreProvider,
  sql: SqlRunner,
  opts: NeonRagStoreOptions = {},
): RagStore {
  switch (provider) {
    case "neon":
      return createNeonRagStore(sql, opts);
    default: {
      const unhandled: never = provider;
      throw new Error(`no RagStore adapter for provider: ${String(unhandled)}`);
    }
  }
}
