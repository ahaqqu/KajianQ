/**
 * Thresholds, vocabulary and result shapes of the matn reconciliation cascade.
 *
 * The two thresholds are pre-registered, not tuned: a pair at or above the auto
 * threshold joins without asking anyone, a pair inside the band must be adjudicated,
 * and below the band there is no match. A band that cannot be adjudicated stays
 * unresolved — it never collapses into either neighbour.
 */

import type { CallBudget } from "./sanadset-budget";
import type { PreparedRow, QuarantinedRow } from "./sanadset-prepare";

/** Pre-registered auto-match threshold: at or above this, the pair joins. */
export const S1_AUTO_MATCH_THRESHOLD = 0.9;
/** Pre-registered model-band floor: at or above this (and below auto), ask the model. */
export const S1_MODEL_BAND_THRESHOLD = 0.6;
/** Two groups this close to the top score are an ambiguous best match, never a tie-break. */
export const S1_AMBIGUITY_MARGIN = 0.02;

export type MatnVerdict = "same" | "different" | "uncertain";

export type MatnAdjudicator = (input: {
  readonly a: string;
  readonly b: string;
  readonly score: number;
}) => Promise<MatnVerdict>;

export type MatnDecisionKind =
  | "exact"
  | "folded"
  | "trigram"
  | "model-same"
  | "model-different"
  | "band-unresolved"
  | "no-match"
  | "quarantined";

export type BestCandidate = {
  readonly rowIndex: number;
  readonly groupId: number;
  readonly score: number;
};

/** One scored pair, as the sample builder needs to see it (candidates, not verdicts). */
export type ScoredPair = {
  readonly rowIndex: number;
  readonly otherRowIndex: number;
  readonly groupId: number;
  readonly score: number;
};

export type MatnDecision = {
  readonly rowIndex: number;
  readonly kind: MatnDecisionKind;
  readonly groupId: number | null;
  readonly matchedRowIndex: number | null;
  readonly score: number | null;
  readonly bestCandidate: BestCandidate | null;
};

export type MatnGroup = {
  readonly groupId: number;
  readonly representativeRowIndex: number;
  readonly memberCount: number;
};

export type MatnCounts = {
  exact: number;
  folded: number;
  trigram: number;
  modelSame: number;
  modelDifferent: number;
  bandUnresolved: number;
  noMatch: number;
  quarantined: number;
  joinedExisting: number;
  newGroups: number;
  coalescedRows: number;
  bandRows: number;
  scoredRows: number;
  candidateCapHits: number;
};

export type CascadeModelStatus = "not-run" | "run" | "ceiling-reached";

export type CascadeResult = {
  readonly decisions: MatnDecision[];
  readonly groups: MatnGroup[];
  readonly quarantined: QuarantinedRow[];
  readonly counts: MatnCounts;
  readonly model: {
    readonly calls: number;
    readonly ceilingReached: boolean;
    readonly status: CascadeModelStatus;
  };
};

export type CascadeOptions = {
  readonly rows: readonly PreparedRow[];
  readonly adjudicate?: MatnAdjudicator;
  readonly budget?: CallBudget;
  readonly autoThreshold?: number;
  readonly bandThreshold?: number;
  readonly ambiguityMargin?: number;
  readonly onGroupScore?: (pair: ScoredPair) => void;
};

/** Fail on a threshold order that would make a band impossible or overlap the auto rule. */
export function assertThresholds(auto: number, band: number, margin: number): void {
  if (!(band > 0 && band < auto && auto <= 1)) {
    throw new Error(
      `matn cascade: thresholds must satisfy 0 < band < auto <= 1, got ${band}/${auto}`,
    );
  }
  if (!(margin >= 0))
    throw new Error(`matn cascade: ambiguity margin must be non-negative, got ${margin}`);
}
