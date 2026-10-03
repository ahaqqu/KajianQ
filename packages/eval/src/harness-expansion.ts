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
 * deterministically and with no judge: the number of scope-origin refs and the
 * recall the fused refs alone would have scored. A `fusedOnlyRetrievalRecall`
 * below the reported `retrievalRecall` is the report's own statement that the
 * expansion carried the question. The metric itself is never redefined.
 *
 * **"The fused refs alone" means the refs that carry NO origin label** (review
 * A4 of the #274 fix round). Every deterministic expansion path labels its own
 * chunks — the fused tracks leave `origin` unset by contract — so the leg is
 * defined by that absence rather than by "not this one label". Excluding only
 * `expansionOrigin` counted ADR-0049's `verse_neighbours` chunks as fused, and
 * on a question the neighbour path carried the metric silently became equal to
 * the reported recall, destroying exactly the statement this block exists to
 * make. A future expansion cannot reintroduce that by forgetting a name here:
 * whichever label it writes, its chunks leave the fused-only leg.
 *
 * The reported `expansion.chunks` is deliberately still the **scope** path's
 * count (ADR-0045's published meaning, ADR-0049's Consequences), so the block
 * is emitted when the scoped path ran — a labelled chunk or the typed event —
 * and a neighbour-only question reports no block rather than a block whose
 * `chunks` would have to be redefined. The neighbour path's own contribution is
 * on the trace: its typed event and each ref's `origin`.
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
        // Absence of an origin label is what makes a ref a fused hit; see the
        // A4 note above — a named exclusion list would have to be kept in step
        // with every expansion path, and it was not.
        input.chunks.filter((chunk) => chunk.origin === undefined),
        input.sourceTypeOf,
      ),
    },
  };
}
