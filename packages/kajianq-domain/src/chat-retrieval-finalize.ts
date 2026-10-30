import { Effect } from "effect";
import type { Chunk, RunContextService } from "@app/rag-core";
import { applyCallerPriority } from "./chat-caller-priority";
import type { TrackHit } from "./chat-fusion";
import { recordChainEvidence, type ChainSeam } from "./chat-retrieval-chains";

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
 */
export type RetrievalTailDeps = {
  callerLists: readonly (readonly TrackHit[])[];
  returned: readonly Chunk[];
  k: number;
  run: RunContextService;
  /** The chain-evidence seam; absent means this deployment carries no catalogue. */
  chains?: ChainSeam;
};

export function finalizeRetrieval(
  deps: RetrievalTailDeps,
): Effect.Effect<readonly Chunk[], { cause: unknown }> {
  return Effect.gen(function* () {
    const returned = yield* recordChainEvidence({
      chunks: deps.returned,
      seam: deps.chains,
      run: deps.run,
    });
    return applyCallerPriority({
      callerLists: deps.callerLists.map((list) => [...list]),
      returned: [...returned],
      k: deps.k,
      at: deps.run.now(),
      record: (event) => deps.run.record(event),
    });
  });
}
