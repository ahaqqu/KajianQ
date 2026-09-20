import type { RagStore } from "./rag-store";
import { createPostgresRagStore, type SqlRunner } from "./rag-store-postgres";
import type { PostgresRagStoreOptions } from "./rag-store-postgres-logging";

/**
 * Persistence backends that have a RagStore adapter in this package. The
 * union grows only when a second adapter actually lands (issue #63: do not
 * pre-provision 'sqlite'/'memory' stubs — pluggability is served by the
 * interface, not by speculative adapters).
 *
 * One entry, and it is named for the DIALECT rather than the host: the adapter
 * speaks Postgres (pgvector + tsvector), and post-ADR-0044 that Postgres is
 * self-hosted on the netcup VPS rather than a managed vendor. Naming the
 * provider "neon" would have made a hosting move look like a storage-engine
 * change.
 */
export type RagStoreProvider = "postgres";

/**
 * Provider-selection factory over the RagStore adapters (ADR-0008 seam,
 * issue #63 item 2). Callers name a backend by role instead of importing a
 * concrete adapter constructor, so swapping persistence stays a wiring edit.
 *
 * `sql` is the driver query handle for the chosen backend (structurally the
 * `pg` runner); adapter options are forwarded verbatim. The exhaustive switch
 * makes adding a provider to the union without implementing it a compile-time
 * failure at this switch, not a runtime surprise.
 */
export function createRagStore(
  provider: RagStoreProvider,
  sql: SqlRunner,
  opts: PostgresRagStoreOptions = {},
): RagStore {
  switch (provider) {
    case "postgres":
      return createPostgresRagStore(sql, opts);
    default: {
      const unhandled: never = provider;
      throw new Error(`no RagStore adapter for provider: ${String(unhandled)}`);
    }
  }
}
