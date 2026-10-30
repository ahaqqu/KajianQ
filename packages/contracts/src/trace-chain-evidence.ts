import * as v from "valibot";
import { CostRecordSchema } from "./trace-primitives";

/**
 * The `chain_evidence` trace event variant: the transmission rows retrieval read
 * for the children it put in context, recorded beside the `retrieval` event.
 *
 * **Why it exists.** A chunk's own metadata carries at most one flattened
 * classification, while hadith science grades the transmission, so the same
 * passage can be sound through one chain and weak through another. A citation
 * that presented only the flattened value would be a claim the store never made,
 * and a trace that showed none of the rows could not tell "this evidence has no
 * chain" from "nobody looked". This event is that record: which children were
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
