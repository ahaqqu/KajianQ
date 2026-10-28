import { Effect } from "effect";
import { modelConfigKey, type ModelConfigRecord, type RagStore } from "@app/infra";

/**
 * The in-memory `model_configs` mirror — the test seam's twin of the Postgres
 * adapter (ADR-0022 decision 3).
 *
 * The semantics that must match production are the ones the admin depends on: the
 * sync REPLACES the mirror with the derived set (same key → one row, no row the set
 * does not name), so running it twice leaves the same rows, and the list comes back
 * sorted the way the adapter's `ORDER BY (role, provider, model_id)` does. The write
 * is a single synchronous swap, the in-memory stand-in for the adapter's one
 * transaction.
 */
export type MemoryModelConfigState = {
  rows: Map<string, ModelConfigRecord>;
  /** The seam has no clock; a test may pin this to keep timestamps deterministic. */
  now: () => number;
};

type MemoryModelConfigMethods = Pick<RagStore, "syncModelConfigs" | "listModelConfigs"> & {
  allModelConfigs: () => readonly ModelConfigRecord[];
};

function compare(a: ModelConfigRecord, b: ModelConfigRecord): number {
  if (a.role !== b.role) return a.role < b.role ? -1 : 1;
  if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
  if (a.modelId !== b.modelId) return a.modelId < b.modelId ? -1 : 1;
  return 0;
}

export function memoryModelConfigMethods(state: MemoryModelConfigState): MemoryModelConfigMethods {
  return {
    allModelConfigs: () => [...state.rows.values()].sort(compare),
    syncModelConfigs(entries) {
      return Effect.sync(() => {
        const next = new Map<string, ModelConfigRecord>();
        const updatedAt = state.now();
        for (const entry of entries) {
          next.set(modelConfigKey(entry), { ...entry, active: true, updatedAt });
        }
        state.rows.clear();
        for (const [key, row] of next) state.rows.set(key, row);
      });
    },
    listModelConfigs() {
      return Effect.sync(() => [...state.rows.values()].sort(compare).map((row) => ({ ...row })));
    },
  };
}
