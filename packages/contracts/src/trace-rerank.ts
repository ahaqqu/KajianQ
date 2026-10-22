import * as v from "valibot";
import { CostRecordSchema } from "./trace-primitives";

/**
 * The `rerank` trace event variant: a decision-model reorder of the retrieval
 * candidates, recorded before the assembler lays the context out (ADR-0042's
 * seam applied to retrieval).
 *
 * **What the event means.** The retriever's fused candidates were offered to
 * the decision model as one `Choice` question; `outcome: "applied"` means the
 * returned distribution reordered them, and `outcome: "preserved"` means the
 * fused order stands unchanged. Preserved is the fail-open verdict for every
 * way the screen can go wrong — a vendor failure, an unusable answer, an
 * answer inconsistent with its own distribution, and a candidate list too
 * short to rank — so a trace carrying it says the reorder did not happen, not
 * that it was judged unnecessary. Both outcomes are first-class content; the
 * call's spend rides on the sibling `llm_call` event, exactly as the reviewer
 * pre-gate's does.
 *
 * **Reading it.** `items` is in REQUEST order — the fused order the model saw —
 * so `index` is the candidate's rank before and `rankAfter` its rank after.
 * `fusedScore` is the RRF score retrieval gave it; `rerankScore` is the
 * decision model's per-candidate probability. Both are recorded so a tuning
 * pass can read the reorder from the trace alone, without re-running a vendor
 * that may have changed. `rerankScore` is absent on a preserved event: an
 * unusable answer is not partially trusted.
 *
 * Owner module, composed verbatim into the closed {@link TraceEventSchema}
 * union: `kind` stays the only discriminator and no reader branches on a
 * module (the split `trace-product-rules` takes, for the same 300-line cap).
 */
export const rerankEventSchema = v.object({
  stage: v.literal("retriever"),
  kind: v.literal("rerank"),
  detail: v.object({
    /** Caller-supplied label for the screen (e.g. "rerank"). */
    purpose: v.optional(v.pipe(v.string(), v.minLength(1))),
    /** `applied` = the distribution reordered the candidates; `preserved` =
     * the fused order stands (fail-open). */
    outcome: v.picklist(["applied", "preserved"]),
    /**
     * Why the fused order was preserved — absent on an applied outcome, like
     * the decision event's escalation reason. Closed, generic vocabulary:
     * nothing to rank (`no_candidates`), one candidate (`single_candidate`),
     * the call failed (`vendor_failure`), no usable distribution
     * (`malformed_answer`), or an answer that contradicts its own distribution
     * (`ambiguous_answer`).
     */
    reason: v.optional(
      v.picklist([
        "no_candidates",
        "single_candidate",
        "vendor_failure",
        "malformed_answer",
        "ambiguous_answer",
      ]),
    ),
    /** Per-candidate provenance, in request (fused) order. */
    items: v.array(
      v.object({
        /** The candidate's position in the request — its fused rank, 0-based. */
        index: v.pipe(v.number(), v.integer(), v.minValue(0)),
        /** The candidate's identity in the request (the retrieved chunk id). */
        key: v.pipe(v.string(), v.minLength(1)),
        /** The RRF score the candidate entered the screen with. */
        fusedScore: v.optional(v.number()),
        /** The decision model's probability for this candidate, 0..1. */
        rerankScore: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
        /** The candidate's position after an applied reorder, 0-based; absent
         * when the fused order was preserved. */
        rankAfter: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      }),
    ),
  }),
  cost: v.optional(CostRecordSchema),
  at: v.pipe(v.number(), v.integer()),
});
