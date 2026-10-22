import { createRerankedRetriever, type Decider, type Retriever } from "@app/rag-core";
import {
  createKajianQRetriever,
  type RetrieverEmbedder,
  type RetrieverStore,
  type StoreBridge,
} from "./chat-retriever";
import { RERANK_INSTRUCTIONS } from "./decision-bench-prompts";
import type { KajianQFilters } from "./filters";

/**
 * The retrieval stage's composition (spec §3.3 item 4): the hybrid retriever,
 * wrapped by the decision-model rerank when the serving role is bound.
 *
 * The rerank decorator is engine-level and takes its wording from this pack —
 * the same language-neutral `Choice` instruction the multilingual decision
 * gate benchmarked — so the retrieval stage stays domain-typed here while the
 * screen itself never learns what a hadith or an ayah is.
 *
 * #169 (the relevance screen) composes as an INNER decorator: the screen runs
 * first, the rerank orders its survivors. The order is the point of the seam —
 * a filter applied outside the rerank would screen an already-reordered list
 * and the rerank would have ranked candidates the generator never sees.
 */
export type { RetrieverEmbedder, RetrieverStore, StoreBridge } from "./chat-retriever";

export type ChatRetrieverDeps = {
  store: RetrieverStore;
  embedder: RetrieverEmbedder;
  bridge: StoreBridge;
  /** Per-track hits per sub-query; absent = the retriever's default. */
  limit?: number;
  /** ADR-0045's shared surah-read budget; absent = the domain default. */
  scopeExpansionCap?: number;
  /** The citation-label lookup's budget; absent = the domain default. */
  labelLookupCap?: number;
  /**
   * The decision-model serving role's rerank screen. Null = the vendor's key
   * is not bound, so the fused order stands and no call is made — the same
   * key-governed posture as the reviewer pre-gate, with no separate toggle.
   */
  rerankDecider: Decider | null;
};

export function createChatRetriever(deps: ChatRetrieverDeps): Retriever<KajianQFilters> {
  const retriever = createKajianQRetriever({
    store: deps.store,
    embedder: deps.embedder,
    bridge: deps.bridge,
    ...(deps.limit !== undefined ? { limit: deps.limit } : {}),
    ...(deps.scopeExpansionCap !== undefined ? { scopeExpansionCap: deps.scopeExpansionCap } : {}),
    ...(deps.labelLookupCap !== undefined ? { labelLookupCap: deps.labelLookupCap } : {}),
  });
  return deps.rerankDecider === null
    ? retriever
    : createRerankedRetriever(retriever, {
        decider: deps.rerankDecider,
        instructions: RERANK_INSTRUCTIONS,
      });
}
