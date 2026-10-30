import * as v from "valibot";
import { CALLER_PRIORITY_K, CostRecordSchema, SEARCH_HITS_TRACE_LIMIT } from "./trace-primitives";

/**
 * The retriever's trace variants that do not fit in the union's own file: the
 * raw per-search hit list (`search_hits`), the caller's guaranteed leading hits
 * (`caller_priority`), and the decision-model reorder (`rerank`) of the fused
 * candidates.
 *
 * Owner module, composed verbatim into the closed {@link TraceEventSchema}
 * union: `kind` stays the only discriminator and no reader branches on a
 * module (the split `trace-product-rules` takes, for the same 300-line cap).
 */

/**
 * The `search_hits` trace event variant: one record per sub-query × embedding-
 * track search, carrying the raw list that search returned — distinct from the
 * fused `retrieval` event, which carries the set fusion produced.
 *
 * **Why it exists.** The fused set cannot answer "did the search ever see this
 * row?": a row absent from it may never have been returned, or may have been
 * dropped between the search and the fusion. `hits` is the search's full count
 * and `topHits` the rows it returned, so the two states are distinguishable
 * across the returned list, not only its leading rows. The list is ids and
 * dense ranks only — never text or metadata, because a chunk's text already
 * rides the fused `retrieval` event.
 *
 * **Identity, not text.** `role`/`origin` are the same caller-chosen labels
 * the sub-query's `subquery` event carries; the text is deliberately not
 * repeated. Both are optional because the engine's `SubQuery` carries them
 * optionally; their absence is not a third value.
 *
 * `topHits` is in ascending dense-rank order, read from `rankDense` rather than
 * from the adapter's array order (the seam promises none), and it never claims
 * more rows than `hits`. It is capped at {@link SEARCH_HITS_TRACE_LIMIT} — the
 * store's own per-search bound — so a search cannot persist a truncated record;
 * a search that returned more than its bound fails this parse instead. A search
 * that returned nothing records `hits: 0` with an empty list: "the search saw
 * nothing" is a result, and the record must not read the same as a search that
 * never ran.
 */
export const searchHitsEventSchema = v.object({
  stage: v.literal("retriever"),
  kind: v.literal("search_hits"),
  detail: v.pipe(
    v.object({
      /** The sub-query's caller-chosen role, as on its `subquery` event. */
      role: v.optional(v.pipe(v.string(), v.minLength(1))),
      /** What produced the sub-query, as on its `subquery` event. */
      origin: v.optional(v.pipe(v.string(), v.minLength(1))),
      /** The embedding track this search ran on (opaque label). */
      track: v.pipe(v.string(), v.minLength(1)),
      /** How many rows this search returned before fusion or reranking. */
      hits: v.pipe(v.number(), v.integer(), v.minValue(0)),
      /** The rows this search returned, in ascending dense rank — raw, pre-fusion. */
      topHits: v.pipe(
        v.array(
          v.object({
            id: v.pipe(v.string(), v.minLength(1)),
            /** The row's 1-based dense rank in this search. */
            rankDense: v.pipe(v.number(), v.integer(), v.minValue(1)),
          }),
        ),
        v.maxLength(SEARCH_HITS_TRACE_LIMIT),
      ),
    }),
    // The count and the list are one record: a list longer than the count
    // describes a search that never happened, and it is the pairing every reader
    // of this event relies on to tell "returned nothing" from "returned a sample".
    v.check((detail) => detail.topHits.length <= detail.hits, "topHits cannot exceed hits"),
  ),
  cost: v.optional(CostRecordSchema),
  at: v.pipe(v.number(), v.integer()),
});

/**
 * The `caller_priority` trace event variant: the caller's own query's leading
 * dense hits, promoted ahead of their fusion rank — out of the rerank's reorder
 * and to the head of their presentation slot in the assembled context.
 *
 * **Why it exists.** Fusion weighs every sub-query list alike, and the router's
 * paraphrases outnumber the caller's single list, so paraphrase rows at a
 * middling rank can outscore the caller's leading row. The caller's words are
 * the one query guaranteed to be in the user's vocabulary, so its strongest
 * rows are a retrieval angle of their own and this record names them.
 *
 * **Identity, not text.** `ids` are chunk ids in the caller list's dense-rank
 * order; the chunk text already rides the `retrieval` event. `k` is the bound
 * the run applied, never more than the contract's ceiling, and `ids` never
 * exceeds it. `alreadyPresent` names the ids the returned set already held;
 * fusion keeps every row a search returned, so a shorter list names a caller hit
 * fusion never returned — the guarantee's inclusion floor is fusion's, and this
 * field is where a break in it shows. The arm reads no store: the caller's own
 * searches already produced this list.
 */
export const callerPriorityEventSchema = v.object({
  stage: v.literal("retriever"),
  kind: v.literal("caller_priority"),
  detail: v.pipe(
    v.object({
      /** The bound the run applied — at most the contract's `CALLER_PRIORITY_K`. */
      k: v.pipe(v.number(), v.integer(), v.minValue(0)),
      /** The guaranteed hits, in the caller list's ascending dense rank. */
      ids: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.maxLength(CALLER_PRIORITY_K)),
      /** Of `ids`, the rows the returned set already carried. */
      alreadyPresent: v.pipe(
        v.array(v.pipe(v.string(), v.minLength(1))),
        v.maxLength(CALLER_PRIORITY_K),
      ),
    }),
    v.check(
      (detail) => detail.alreadyPresent.every((id) => detail.ids.includes(id)),
      "alreadyPresent must name ids in the guaranteed set",
    ),
    v.check((detail) => detail.ids.length <= detail.k, "ids must fit the bound the run applied"),
  ),
  cost: v.optional(CostRecordSchema),
  at: v.pipe(v.number(), v.integer()),
});

/**
 * The `rerank` trace event variant: a decision-model reorder of the retrieval
 * candidates, recorded before the assembler lays the context out (ADR-0042's
 * seam applied to retrieval).
 *
 * **What the event means.** The retriever's fused candidates were offered to
 * the decision model as one `Choice` question; `outcome: "applied"` means the
 * returned distribution reordered them, and `outcome: "preserved"` means the
 * fused order stands unchanged. Preserved is the fail-open verdict for every
 * way the rerank can go wrong — a vendor failure or thrown defect, an
 * unreadable answer, an answer inconsistent with its own distribution, and a
 * candidate list too short to rank — so a trace carrying it says the reorder
 * did not happen, not that it was judged unnecessary. Its `reason` names the
 * rule that fired. Both outcomes are first-class content; the call's spend
 * rides on the sibling `llm_call` event, exactly as the reviewer pre-gate's
 * does.
 *
 * **Reading it.** `items` is in REQUEST order — the fused order the model saw —
 * so `index` is the candidate's rank before and `rankAfter` its rank within the
 * fused block after. A caller-labelled chunk (one carrying `origin`) is never
 * reordered and keeps its position, so on a list where arms are interleaved a
 * fused candidate's list position can differ from `rankAfter`. `fusedScore` is
 * the RRF score retrieval gave it; `rerankScore` is the decision model's
 * per-candidate probability. Both are recorded so a tuning pass can read the
 * reorder from the trace alone, without re-running a vendor that may have
 * changed. `rerankScore` is absent on a preserved event: an unusable answer is
 * not partially trusted.
 */
export const rerankEventSchema = v.object({
  stage: v.literal("retriever"),
  kind: v.literal("rerank"),
  detail: v.object({
    /** Caller-supplied label for this pass (e.g. "rerank"). */
    purpose: v.optional(v.pipe(v.string(), v.minLength(1))),
    /** `applied` = the distribution reordered the candidates; `preserved` =
     * the fused order stands (fail-open). */
    outcome: v.picklist(["applied", "preserved"]),
    /**
     * Why the fused order was preserved — absent on an applied outcome, like
     * the decision event's escalation reason. Closed, generic vocabulary, one
     * value per rule: fewer than two candidates to rank (`too_few_candidates`
     * — the items say whether there were none or one), a typed vendor failure
     * (`vendor_failure`), a thrown defect (`thrown`), a missing or non-Choice
     * answer (`non_choice`), a candidate probability absent or outside 0..1
     * (`missing_probability`), a choice that is not a candidate key
     * (`choice_outside_options`), a choice past the offered range
     * (`out_of_range_choice`), or a choice that is not a positive maximum of
     * its own distribution (`choice_not_argmax`).
     */
    reason: v.optional(
      v.picklist([
        "too_few_candidates",
        "vendor_failure",
        "thrown",
        "non_choice",
        "missing_probability",
        "choice_outside_options",
        "out_of_range_choice",
        "choice_not_argmax",
      ]),
    ),
    /** Per-candidate provenance, in request (fused) order. */
    items: v.array(
      v.object({
        /** The candidate's position in the request — its fused rank, 0-based. */
        index: v.pipe(v.number(), v.integer(), v.minValue(0)),
        /** The candidate's identity in the request (the retrieved chunk id). */
        key: v.pipe(v.string(), v.minLength(1)),
        /** The RRF score the candidate entered the rerank with. */
        fusedScore: v.optional(v.number()),
        /** The decision model's probability for this candidate, 0..1. */
        rerankScore: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
        /** The candidate's rank within the fused block after an applied
         * reorder, 0-based; absent when the fused order was preserved. A
         * labelled chunk is not part of this block, so the position in the
         * returned list can differ where arms are interleaved. */
        rankAfter: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      }),
    ),
  }),
  cost: v.optional(CostRecordSchema),
  at: v.pipe(v.number(), v.integer()),
});

/**
 * The `chain_evidence` trace event variant: the transmission rows retrieval read
 * for the children it put in context, recorded beside the `retrieval` event.
 *
 * **Why it exists.** A chunk's own metadata carries at most one flattened
 * classification, while the source classifies each transmission separately, so
 * the same passage can be sound through one chain and weak through another. A
 * citation that presented only the flattened value would be a claim the store
 * never made, and a trace that showed none of the rows could not tell "this
 * evidence has no chain" from "nobody looked". This event is that record: which children were
 * consulted, how many rows each holds, and every row's ordered narrator sequence
 * with its classification and attribution.
 *
 * **Neutrality is structural.** `chains` is stored order (the seam's insertion
 * sequence), never a classification ranking, and it is the FULL list the read
 * returned for the child — a reader must be able to present every row, so a
 * producer may not sort it, dedupe it, or drop the weaker ones. The event is
 * written even when no row exists (`consulted` counts the children read,
 * `children` stays empty): "the evidence carries no transmission row" is a
 * result, and it must not read the same as a run that never read.
 *
 * A grade never travels alone: `grade` and `grader` are present or absent
 * together, mirroring the schema's attribution constraint, so a reader can never
 * render an unattributed classification.
 */

/**
 * The most rows one child's record carries — the bound the read applies per
 * child, so the event cannot persist a truncated list as if it were the whole
 * transmission. A child whose stored rows exceed it records the bound and the
 * prefix; the count is the honest signal that more exist.
 */
export const CHAIN_EVIDENCE_TRACE_LIMIT = 8;

/** One transmission row: the ordered sequence, its classification and the grader. */
export const chainEvidenceRowSchema = v.pipe(
  v.object({
    /** The ordered narrator sequence, exactly as stored — order is the chain. */
    narratorIds: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
    /** The row's classification, or absent when no verdict exists. */
    grade: v.optional(v.pipe(v.string(), v.minLength(1))),
    /** The grader whose verdict `grade` is. Present exactly when `grade` is. */
    grader: v.optional(v.pipe(v.string(), v.minLength(1))),
    /** The source's own address for the row, when it has one. */
    sourceRef: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.check(
    (row) => (row.grade === undefined) === (row.grader === undefined),
    "a chain row carries its grade and grader together",
  ),
);

export type ChainEvidenceRow = v.InferOutput<typeof chainEvidenceRowSchema>;

/** One consulted child and the rows the read returned for it. */
export const chainEvidenceChildSchema = v.object({
  childId: v.pipe(v.string(), v.minLength(1)),
  /** In stored order, never re-ranked by classification. */
  chains: v.pipe(v.array(chainEvidenceRowSchema), v.maxLength(CHAIN_EVIDENCE_TRACE_LIMIT)),
  /**
   * True when the child holds more rows than the bound carried. The list is then
   * a prefix, and a consumer that renders only it must say so rather than present
   * a partial transmission as the whole.
   */
  moreMayExist: v.optional(v.boolean()),
});

export type ChainEvidenceChild = v.InferOutput<typeof chainEvidenceChildSchema>;

export const chainEvidenceDetailSchema = v.object({
  /** How many retrieved children the read covered, whether or not each had a row. */
  consulted: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** The per-child bound the run applied. */
  perChildCap: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** The children that hold at least one row, in retrieval order. */
  children: v.array(chainEvidenceChildSchema),
  /**
   * Narrator ids a chain named that the catalogue does not hold, in first-seen
   * order. Reported rather than dropped: an unknown narrator is a resolution gap,
   * and a citation that rendered the chain without it would hide one.
   */
  missingNarratorIds: v.array(v.pipe(v.string(), v.minLength(1))),
});

export type ChainEvidenceDetail = v.InferOutput<typeof chainEvidenceDetailSchema>;

export const chainEvidenceEventSchema = v.object({
  stage: v.literal("retriever"),
  kind: v.literal("chain_evidence"),
  detail: chainEvidenceDetailSchema,
  cost: v.optional(CostRecordSchema),
  at: v.pipe(v.number(), v.integer()),
});
