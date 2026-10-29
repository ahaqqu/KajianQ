/**
 * Thresholds, vocabulary and result shapes of the matn reconciliation cascade.
 *
 * The two thresholds are pre-registered, not tuned: a pair at or above the auto
 * threshold joins without asking anyone, a pair inside `[band, auto)` must be
 * adjudicated, and below the band there is no match. The band is a half-open interval
 * with both ends explicit — a row at or above the auto threshold never enters it, and a
 * band that cannot be adjudicated stays unresolved rather than collapsing into either
 * neighbour.
 */

import type { CallBudget } from "./sanadset-budget";
import type { PreparedRow, QuarantinedRow, QuarantineRule } from "./sanadset-prepare";

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
  /** The quarantine rule for a `quarantined` decision, else null: a reader never guesses why. */
  readonly rule: QuarantineRule | null;
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
  /** Rows inside `[band, auto)` that reached (or would have reached) the adjudicator. */
  bandAdjudicated: number;
  /** Rows inside `[band, auto)` held back by the ambiguity rule: no model call is spent. */
  ambiguousQuarantined: number;
  scoredRows: number;
  candidateCapHits: number;
};

export type CascadeModelStatus = "not-run" | "run" | "ceiling-reached";

/** The book scope of the group book: per book (the study's rule) or global (a diagnostic). */
export type CascadeBookScope = "book" | "global";

export type CascadeThresholds = {
  readonly band: number;
  readonly auto: number;
  readonly ambiguityMargin: number;
};

/**
 * The book scope's effect, measured on this run's data rather than asserted: the same
 * cascade is replayed against an unscoped book, and the joins it would have made across
 * books are counted. Only deterministic joins are counted — a `model-same` verdict on a
 * keyed run is a band decision, not a lexical one, so the count is a floor.
 */
export type CrossBookJoins = {
  /** Cross-book joins in the run's own book. Zero under `book` scope, asserted as a fact. */
  readonly joinsInThisRun: number;
  readonly unscopedTotal: number;
  readonly unscopedExact: number;
  readonly unscopedFolded: number;
  readonly unscopedTrigram: number;
  /** Children the scoped book produced: what an isnad attaches to in S2. */
  readonly scopedChildren: number;
  /** Children an unscoped book would have produced. */
  readonly unscopedChildren: number;
};

export type CascadeResult = {
  readonly decisions: MatnDecision[];
  readonly groups: MatnGroup[];
  readonly quarantined: QuarantinedRow[];
  readonly counts: MatnCounts;
  readonly thresholds: CascadeThresholds;
  readonly bookScope: CascadeBookScope;
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
  /**
   * `book` (the default) groups matns per book: two books' texts are never the same
   * child. `global` reproduces an unscoped book and exists so the study can measure what
   * the scope prevents, without a second definition of the cascade.
   */
  readonly bookScope?: CascadeBookScope;
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

/** A zeroed count block; the cascade mutates one as it decides. */
export function emptyMatnCounts(): MatnCounts {
  return {
    exact: 0,
    folded: 0,
    trigram: 0,
    modelSame: 0,
    modelDifferent: 0,
    bandUnresolved: 0,
    noMatch: 0,
    quarantined: 0,
    joinedExisting: 0,
    newGroups: 0,
    coalescedRows: 0,
    bandAdjudicated: 0,
    ambiguousQuarantined: 0,
    scoredRows: 0,
    candidateCapHits: 0,
  };
}
