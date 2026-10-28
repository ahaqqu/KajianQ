import type { StoreError } from "@app/rag-core";
import type { Effect } from "effect";

/**
 * Model-config mirror half of the `RagStore` seam (ADR-0022 decision 3).
 *
 * The provider config file is the source of truth; `model_configs` is derived from
 * it. The seam offers exactly two operations, and their contract is the mirror
 * invariant:
 *
 *  - `syncModelConfigs` makes the mirror equal the given row set. Every entry is
 *    upserted by its `(role, provider, model_id)` key and every row the set does not
 *    name is removed, in ONE store operation. Re-running it with the same set leaves
 *    the same rows (idempotent under the table's unique constraint), and a model
 *    removed from the config cannot survive in the mirror claiming to be current.
 *  - `listModelConfigs` returns every row, ordered by `(role, provider, model_id)`,
 *    so the drift check and the admin detail read one deterministic set.
 *
 * There is deliberately no single-row write: a caller that could update one row could
 * make the mirror disagree with the config it is derived from.
 */
export type ModelConfigEntry = {
  role: string;
  provider: string;
  modelId: string;
  /** The model config's own payload — capabilities, dimensions, price, vendor terms. */
  config: Record<string, unknown>;
};

export type ModelConfigRecord = ModelConfigEntry & {
  active: boolean;
  /** When the row was last written, in epoch milliseconds. */
  updatedAt: number;
};

export interface RagStoreModelConfig {
  syncModelConfigs(entries: readonly ModelConfigEntry[]): Effect.Effect<void, StoreError>;

  listModelConfigs(): Effect.Effect<readonly ModelConfigRecord[], StoreError>;
}
