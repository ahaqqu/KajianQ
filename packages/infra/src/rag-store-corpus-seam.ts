import type { Effect } from "effect";
import type { StoreError } from "@app/rag-core";
import type {
  AlignedPairInsert,
  DocChildById,
  DocChildInsert,
  DocParentInsert,
  RetrievalTrack,
  SimilarChild,
} from "./rag-store";

// Re-exported here so `rag-store.ts` need not import @app/rag-core directly.
export type { StoreError };

/** Corpus read/write half of the `RagStore` seam; `RagStore` extends it, so
 * consumers see one unchanged seam. */
export interface RagStoreCorpus {
  insertDocParent(input: DocParentInsert): Effect.Effect<string, StoreError>;

  insertDocChild(input: DocChildInsert): Effect.Effect<string, StoreError>;

  /** Insert a batch of child chunks in one call. Adapters may perform a
   * multi-row upsert; the default implementation falls back to serial
   * `insertDocChild` calls, so consumers never need to know which. */
  insertDocChildren(batch: readonly DocChildInsert[]): Effect.Effect<readonly string[], StoreError>;

  /** Upsert an aligned text pair (provenance-keyed, idempotent), returning the
   * persisted pair id that downstream evidence rows reference. */
  upsertAlignedPair(input: AlignedPairInsert): Effect.Effect<string, StoreError>;

  /** Count child chunks grouped by one `metadata` JSONB key's string value. The
   * key is bound as a parameter (never interpolated) and never interpreted; rows
   * where it is absent or non-string collapse under `null`. This is the read
   * behind the ingest CLIs' `--only-missing` guard. */
  countDocChildrenByMetadata(
    key: string,
  ): Effect.Effect<readonly { value: string | null; count: number }[], StoreError>;

  /** Nearest-neighbour similarity search over one embedding track. `filters` are
   * exact-match against `metadata` JSONB keys, passed through untouched.
   *
   * A hit's embeddings are `null` — the search used the vectors to order the
   * rows, so re-shipping them is dead weight; only those two fields are
   * unpopulated, keeping ids/text/citation/metadata one shape. */
  similaritySearch(
    track: RetrievalTrack,
    embedding: readonly number[],
    opts: {
      limit: number;
      filters?: Record<string, string | readonly string[]>;
    },
  ): Effect.Effect<readonly SimilarChild[], StoreError>;

  /** Fetch child chunks by id (deduplicated; absent ids simply missing), with the
   * parent display title and NO embeddings. A trace's retrieval chunk refs
   * resolve here, so display data comes from the rows retrieval served. */
  getDocChildrenByIds(ids: readonly string[]): Effect.Effect<readonly DocChildById[], StoreError>;

  /** List a parent's child chunks in stable within-parent order (`ordinal`
   * ascending), at most `limit` rows, with no embeddings and the parent title.
   * The parent is addressed by its opaque `source_key` — the store never learns
   * what that document is. `limit` is required so a caller cannot read an
   * unbounded child set by accident; `limit <= 0` returns no rows. */
  listDocChildrenByParentSourceKey(
    parentSourceKey: string,
    opts: { limit: number },
  ): Effect.Effect<readonly DocChildById[], StoreError>;

  /**
   * The children **neighbouring** the given anchor children inside their own
   * parent: at most `radius` positions before and after each anchor, in stable
   * within-parent `ordinal` order. Anchors are addressed by **child id**, and the
   * store derives each anchor's parent and ordinal from the stored row, so a
   * window cannot be mis-derived from the caller's copy. Anchors are never
   * returned; only their neighbours are.
   *
   * `anchorChildIds` is the caller's **priority order**: a neighbour reachable
   * from two anchors belongs to the first, and rows order by anchor position
   * then `ordinal`, so a truncating `limit` drops the least important windows.
   * `radius <= 0`, `limit <= 0` and an empty anchor list return no rows without
   * issuing a query; an id no stored row backs anchors nothing.
   */
  listDocChildNeighboursByChildIds(
    anchorChildIds: readonly string[],
    opts: { radius: number; limit: number },
  ): Effect.Effect<readonly DocChildById[], StoreError>;
}
