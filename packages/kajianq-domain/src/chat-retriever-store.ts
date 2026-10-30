import type { Effect } from "effect";
import type { CostRecord, StoreError } from "@app/rag-core";
import type { MetadataFilterValue, NarratorChainRecord, NarratorIdsLookup } from "@app/infra";
import type { NeighbourChildRow } from "./chat-neighbour-expansion";
import type { ScopeChildRow } from "./chat-scope-expansion";

/** The embedding seam the retriever calls once per run. */
export type RetrieverEmbedder = {
  embed(spec: {
    texts: readonly string[];
    /** Required on the serving seam: the embedded texts are the user's sub-queries, i.e.
     * personal data. Non-optional so a call site that drops it is a compile error; the
     * provider seam then skips free-tier candidates. */
    personalData: true;
  }): Effect.Effect<{ vectors: readonly (readonly number[])[]; cost: CostRecord }, unknown>;
};

/**
 * The retriever's store role — the narrow structural view of `RagStore` the
 * stage actually uses. It lives apart from the composition module because the
 * stage is at the agentic line cap, and the role is the store-facing half of
 * the same seam the deterministic arms read.
 *
 * `filters` are opaque metadata keys and values, plus the derived case a value
 * can carry ({@link MetadataFilterValue}) — the engine binds them as parameters
 * and never interprets them.
 */
export type RetrieverStore = {
  similaritySearch(
    track: "primary" | "fallback",
    embedding: readonly number[],
    opts: { limit: number; filters?: Record<string, MetadataFilterValue> },
  ): Effect.Effect<
    readonly {
      child: {
        id: string;
        textAr: string;
        textId: string | null;
        metadata: Record<string, unknown>;
      };
      distance: number;
      rankDense: number;
    }[],
    StoreError
  >;
  /** The bounded, capped read of a surah's children, in the corpus's order,
   * optionally beginning at an ordinal lower bound — a named verse's position. */
  listDocChildrenByParentSourceKey(
    parentSourceKey: string,
    opts: { limit: number; fromOrdinal?: number },
  ): Effect.Effect<readonly ScopeChildRow[], StoreError>;
  /** The bounded read of the children within `radius` ordinals of each anchor child, in
   * the caller's priority order; anchors are opaque child ids, so the window cannot be
   * mis-anchored. */
  listDocChildNeighboursByChildIds(
    anchorChildIds: readonly string[],
    opts: { radius: number; limit: number },
  ): Effect.Effect<readonly NeighbourChildRow[], StoreError>;
  /**
   * The chains attached to one child — the per-chain evidence arm's read. Optional
   * on the role because a narrow unit fixture may model no catalogue at all; the
   * serving composition root pins the full store, so a wiring that drops the read
   * is a compile error there.
   */
  listChainsForChild?(
    childId: string,
    opts: { limit: number },
  ): Effect.Effect<readonly NarratorChainRecord[], StoreError>;
  /** The narrator rows for the ids a chain names, with the unknown ids reported. */
  getNarratorsByIds?(ids: readonly string[]): Effect.Effect<NarratorIdsLookup, StoreError>;
  /** The bounded exact-match read of the children carrying a label's opaque metadata
   * pairs — the one read the citation-label arm issues. */
  findDocChildrenByMetadata(
    match: Readonly<Record<string, string | number>>,
    opts: { limit: number },
  ): Effect.Effect<readonly ScopeChildRow[], StoreError>;
};
