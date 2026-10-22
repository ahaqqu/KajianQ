import { createRerankedRetriever, type Decider, type Retriever } from "@app/rag-core";
import { createKajianQRetriever, type KajianQRetrieverDeps } from "./chat-retriever";
import { RERANK_INSTRUCTIONS } from "./decision-bench-prompts";
import type { KajianQFilters } from "./filters";

/**
 * The retrieval stage's composition (spec §3.3 item 4): the hybrid retriever,
 * wrapped by the decision-model rerank when the serving role is bound.
 *
 * The rerank decorator is engine-level and takes its wording from this pack —
 * the same language-neutral `Choice` instruction the multilingual decision
 * gate benchmarked — so the retrieval stage stays domain-typed here while the
 * rerank itself never learns what a hadith or an ayah is.
 *
 * #169 (the relevance screen) composes as an INNER decorator: the screen runs
 * first, the rerank orders its survivors. The order is the point of the seam —
 * a filter applied outside the rerank would screen an already-reordered list
 * and the rerank would have ranked candidates the generator never sees.
 */
export type { RetrieverEmbedder, RetrieverStore, StoreBridge } from "./chat-retriever";

/**
 * The retriever's own deps extended with the rerank seam. Derived rather than
 * restated so a knob added to the retriever reaches this composition too — a
 * hand-copied subset is how a config field silently stops being forwarded.
 */
export type ChatRetrieverDeps = KajianQRetrieverDeps & {
  /**
   * The decision-model serving role's rerank. Null = the vendor's key is not
   * bound, so the fused order stands and no call is made — the same
   * key-governed posture as the reviewer pre-gate, with no separate toggle.
   */
  rerankDecider: Decider | null;
};

/**
 * The retriever's configurable surface: its options without the seams and the rerank
 * role it is injected with. Derived, never restated — the serving composition root sets
 * every knob from one object and forwards that object whole, so a knob the retriever
 * gains is reachable without a new line, and a knob it stops reading stops type-checking
 * at the call site instead of vanishing into a spread. Each knob is a number or an
 * explicit `undefined`, which is a stated absence: the retriever's own default applies.
 */
export type ChatRetrievalTuning = Omit<
  ChatRetrieverDeps,
  "store" | "embedder" | "bridge" | "rerankDecider"
>;

export function createChatRetriever(deps: ChatRetrieverDeps): Retriever<KajianQFilters> {
  const { rerankDecider, ...retrieverDeps } = deps;
  const retriever = createKajianQRetriever(retrieverDeps);
  return rerankDecider === null
    ? retriever
    : createRerankedRetriever(retriever, {
        decider: rerankDecider,
        instructions: RERANK_INSTRUCTIONS,
      });
}
