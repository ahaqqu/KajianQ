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

// The corpus seam is where the taxonomy type is re-exported to the barrel:
// `rag-store.ts` re-exports `StoreError` from here rather than importing
// @app/rag-core directly, keeping its own import count inside the agentic cap.
export type { StoreError };

/**
 * Corpus read/write half of the `RagStore` seam, split from `rag-store.ts`
 * to respect the agentic 300-line file cap — the same split the eval
 * (`rag-store-eval-seam.ts`) and feedback (`rag-store-feedback-seam.ts`)
 * halves already take. The `RagStore` interface extends this one, so
 * consumers see one unchanged seam.
 */
export interface RagStoreCorpus {
  /** Insert a parent document, returning the effect of its persisted id. */
  insertDocParent(input: DocParentInsert): Effect.Effect<string, StoreError>;

  /** Insert a child chunk tied to a parent, returning the effect of its persisted id. */
  insertDocChild(input: DocChildInsert): Effect.Effect<string, StoreError>;

  /**
   * Insert a batch of child chunks in one call. Adapters may perform a
   * multi-row upsert; callers must still use `insertDocChild` for single-row
   * paths. The default implementation (for adapters that do not implement this
   * method) is to fall back to serial `insertDocChild` calls — consumers of the
   * seam never need to know whether batching is native.
   */
  insertDocChildren(batch: readonly DocChildInsert[]): Effect.Effect<readonly string[], StoreError>;

  /**
   * Upsert an aligned text pair (provenance-keyed, idempotent). Returns the
   * effect of the persisted pair id — the reference downstream
   * `lemma_evidence` rows hold (ADR-0014: the aligned pairs are the
   * concept-graph build's seed source).
   */
  upsertAlignedPair(input: AlignedPairInsert): Effect.Effect<string, StoreError>;

  /**
   * Count child chunks grouped by one `metadata` JSONB key's string value.
   * The key is bound as a parameter (never interpolated), the values are
   * opaque strings, and rows where the key is absent or non-string collapse
   * under `null` — the store does not interpret the key's meaning.
   *
   * The read behind the ingest CLIs' `--only-missing` guard (ADR-0037's
   * recorded revisit trigger, fired by #213): resumption by measured store
   * state needs the per-value landed counts BEFORE a pass acquires sources
   * or spends, so a naive range loop cannot re-pay for collections already
   * landed. The caller owns the domain vocabulary (which key to read); the
   * seam stays engine-generic.
   */
  countDocChildrenByMetadata(
    key: string,
  ): Effect.Effect<readonly { value: string | null; count: number }[], StoreError>;

  /**
   * Nearest-neighbour similarity search over one embedding track. `filters`
   * are exact-match against `metadata` JSONB keys, passed through untouched —
   * the store does not interpret their names.
   *
   * **A hit's embeddings are `null`.** The search used the vectors to order
   * the rows and the caller reads ids/text/metadata, so returning them again
   * is dead weight — and expensive dead weight: 1536 floats per hit is ~39 KB
   * of text, which on an 8-search chat request meant ~3 MB over the wire and
   * ~245k floats parsed inside the Worker (measured 2026-09-12; Cloudflare
   * killed the request as `exceededResources`). The `DocChild` shape is kept
   * so ids/text/citation/metadata stay one type; only the two vector fields
   * are unpopulated by this method.
   */
  similaritySearch(
    track: RetrievalTrack,
    embedding: readonly number[],
    opts: {
      limit: number;
      filters?: Record<string, string | readonly string[]>;
    },
  ): Effect.Effect<readonly SimilarChild[], StoreError>;

  /**
   * Fetch child chunks by id (deduplicated; absent ids simply missing).
   * Like `similaritySearch`, the rows carry NO embeddings, plus the parent
   * display title. The read behind the citation payload (#11): a trace's
   * retrieval chunk refs resolve here, so display data comes from the rows
   * retrieval served.
   */
  getDocChildrenByIds(ids: readonly string[]): Effect.Effect<readonly DocChildById[], StoreError>;
}
