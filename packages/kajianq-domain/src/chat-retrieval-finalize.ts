import { Effect } from "effect";
import type { Chunk, RunContextService } from "@app/rag-core";
import type { TraceEvent } from "@app/contracts";
import { applyCallerPriority } from "./chat-caller-priority";
import type { TrackHit } from "./chat-fusion";
import {
  readChainEvidence,
  type ChainEvidenceBridge,
  type ChainEvidenceStore,
} from "./chat-isnad-evidence";

/**
 * The retriever's tail: attach per-chain evidence to the children going into
 * context, record the read, then lead the set with the caller's guaranteed hits.
 *
 * It lives apart from the stage so the stage's file stays inside the agentic
 * line cap — the same split the retriever's other arms take. The order is the
 * point: the evidence read happens on the final set (after the deterministic
 * arms have added their chunks), so it covers every child the generator will see,
 * and the caller-priority guarantee is applied last as it always was, because a
 * promotion must not change which children were read.
 *
 * **No chain read, no event.** A run with no chain-bearing child records nothing:
 * "nothing was consulted" and "consulted and found nothing" are different facts,
 * and the trace carries the second as `consulted` with an empty list.
 */
/**
 * The chain-evidence seam, built from the retriever's own deps — present only when
 * the store carries both reads, so a narrow fixture that models no catalogue
 * records no evidence read instead of failing, while the serving composition root
 * requires the full store and therefore always takes this path.
 */
export function chainSeamOf(deps: {
  store: {
    listChainsForChild?: ChainEvidenceStore["listChainsForChild"];
    getNarratorsByIds?: ChainEvidenceStore["getNarratorsByIds"];
  };
  bridge: ChainEvidenceBridge;
  childCap?: number | undefined;
  chainCap?: number | undefined;
}): Pick<RetrievalTailDeps, "chains"> {
  const { listChainsForChild, getNarratorsByIds } = deps.store;
  if (listChainsForChild === undefined || getNarratorsByIds === undefined) return {};
  return {
    chains: {
      store: {
        listChainsForChild: listChainsForChild.bind(deps.store),
        getNarratorsByIds: getNarratorsByIds.bind(deps.store),
      },
      bridge: deps.bridge,
      ...(deps.childCap !== undefined ? { childCap: deps.childCap } : {}),
      ...(deps.chainCap !== undefined ? { chainCap: deps.chainCap } : {}),
    },
  };
}

export type RetrievalTailDeps = {
  callerLists: readonly (readonly TrackHit[])[];
  returned: readonly Chunk[];
  k: number;
  run: RunContextService;
  /** The chain-evidence seam; absent means this deployment carries no catalogue. */
  chains?:
    | {
        store: ChainEvidenceStore;
        bridge: ChainEvidenceBridge;
        childCap?: number | undefined;
        chainCap?: number | undefined;
      }
    | undefined;
};

export function finalizeRetrieval(
  deps: RetrievalTailDeps,
): Effect.Effect<readonly Chunk[], { cause: unknown }> {
  return Effect.gen(function* () {
    let returned: readonly Chunk[] = deps.returned;
    if (deps.chains !== undefined) {
      const evidence = yield* readChainEvidence({
        chunks: returned,
        store: deps.chains.store,
        bridge: deps.chains.bridge,
        ...(deps.chains.childCap !== undefined ? { childCap: deps.chains.childCap } : {}),
        ...(deps.chains.chainCap !== undefined ? { chainCap: deps.chains.chainCap } : {}),
      });
      returned = evidence.chunks;
      if (evidence.detail !== null) {
        deps.run.record({
          stage: "retriever",
          kind: "chain_evidence",
          detail: evidence.detail,
          at: deps.run.now(),
        } satisfies TraceEvent);
      }
    }
    return applyCallerPriority({
      callerLists: deps.callerLists.map((list) => [...list]),
      returned: [...returned],
      k: deps.k,
      at: deps.run.now(),
      record: (event) => deps.run.record(event),
    });
  });
}
