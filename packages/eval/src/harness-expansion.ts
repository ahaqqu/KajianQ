import type { EvalResultOutcome } from "@app/contracts";
import type { ChunkRefLike, TraceEventLike } from "./harness-types";
import { retrievalRecall } from "./scorers";

/**
 * The per-question expansion provenance (ADR-0045; C1 of #243's review),
 * split out of `harness.ts` to respect the agentic size limits.
 *
 * The gate's `retrievalRecall` reads the retrieval event's chunk refs and never
 * inspects their `origin` label, so for a question that names a reference the
 * scored leg is satisfied **by construction** whenever the scoped read works —
 * a fused-track regression on exactly those questions would otherwise be
 * invisible in the report. This function says what the expansion contributed,
 * deterministically and with no judge: the number of expansion-origin refs and
 * the recall the fused refs alone would have scored. A `fusedOnlyRetrievalRecall`
 * below the reported `retrievalRecall` is the report's own statement that the
 * expansion carried the question. The metric itself is never redefined.
 */
export function expansionProvenance(input: {
  expectedSourceTypes: readonly string[];
  chunks: readonly ChunkRefLike[];
  events: readonly TraceEventLike[];
  sourceTypeOf: (chunkId: string) => string | undefined;
  /** Opaque caller label (domain vocabulary stays at the composition root). */
  expansionOrigin?: string;
}): { expansion?: EvalResultOutcome["expansion"] } {
  const { expansionOrigin } = input;
  if (expansionOrigin === undefined) return {};
  const expansionChunks = input.chunks.filter((chunk) => chunk.origin === expansionOrigin);
  // A recognised-but-empty scope still counts as "the scoped path ran": it
  // records `chunks: 0` beside the fused-only figure rather than staying silent.
  const scopedPathRan =
    expansionChunks.length > 0 || input.events.some((e) => e.kind === "scope_expansion");
  if (!scopedPathRan) return {};
  return {
    expansion: {
      chunks: expansionChunks.length,
      fusedOnlyRetrievalRecall: retrievalRecall(
        input.expectedSourceTypes,
        input.chunks.filter((chunk) => chunk.origin !== expansionOrigin),
        input.sourceTypeOf,
      ),
    },
  };
}
