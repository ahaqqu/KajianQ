import { Effect } from "effect";
import type { Chunk, RunContextService } from "@app/rag-core";
import type { TraceEvent } from "@app/contracts";
import { readChainEvidence, type ChainEvidenceBridge, type ChainEvidenceStore } from "./chat-isnad";

/**
 * The retriever's chain-evidence seam: the read of the children going into
 * context, and its record on the trace.
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
}): ChainSeam {
  const { listChainsForChild, getNarratorsByIds } = deps.store;
  if (listChainsForChild === undefined || getNarratorsByIds === undefined) return undefined;
  return {
    store: {
      listChainsForChild: listChainsForChild.bind(deps.store),
      getNarratorsByIds: getNarratorsByIds.bind(deps.store),
    },
    bridge: deps.bridge,
    ...(deps.childCap !== undefined ? { childCap: deps.childCap } : {}),
    ...(deps.chainCap !== undefined ? { chainCap: deps.chainCap } : {}),
  };
}

export type ChainSeam =
  | {
      store: ChainEvidenceStore;
      bridge: ChainEvidenceBridge;
      childCap?: number | undefined;
      chainCap?: number | undefined;
    }
  | undefined;

/** Read the evidence for the chunks in context, recording the read when one ran. */
export function recordChainEvidence(input: {
  chunks: readonly Chunk[];
  seam: ChainSeam;
  run: RunContextService;
}): Effect.Effect<readonly Chunk[], { cause: unknown }> {
  if (input.seam === undefined) return Effect.succeed(input.chunks);
  return Effect.map(
    readChainEvidence({
      chunks: input.chunks,
      store: input.seam.store,
      bridge: input.seam.bridge,
      ...(input.seam.childCap !== undefined ? { childCap: input.seam.childCap } : {}),
      ...(input.seam.chainCap !== undefined ? { chainCap: input.seam.chainCap } : {}),
    }),
    (evidence) => {
      if (evidence.detail !== null) {
        input.run.record({
          stage: "retriever",
          kind: "chain_evidence",
          detail: evidence.detail,
          at: input.run.now(),
        } satisfies TraceEvent);
      }
      return evidence.chunks;
    },
  );
}
