/**
 * The pre-registered blind sample: seeded selection, the labels template, and the
 * owner's spot-check sheet.
 *
 * The order of operations is the invariant. The sample is drawn and written before
 * any model output exists, so the pairs cannot have been chosen to flatter an arm,
 * and the presentation files carry no stratum, no lexical score and no predicted
 * label. Anything that would tell a labeller the answer stays in the analyst-side
 * preregistration file.
 *
 * A pair whose two sides are the same string is never drawn, whatever stratum offers
 * it: it is a free correct answer, so it would inflate the macro-F1 this sample exists
 * to measure and spend a call on a question with no signal.
 */

import { fnv1a } from "./sanadset-blocking";
import {
  MATN_STRATA,
  NARRATOR_STRATA,
  type PairCandidates,
  type PairStratum,
  type StudyPair,
} from "./sanadset-pairs";

/** Pinned salt: the draw is a property of the dataset hash plus this constant, never of the clock. */
export const SAMPLE_SEED_SALT = "sanadset-s1-blind-sample-v1";
/** Pairs per kind and per stratum; a short stratum is reported, never fabricated. */
export const SAMPLE_PER_STRATUM = 50;
/** The owner scores this many pairs blind (the labelling-limitation instrument). */
export const OWNER_SPOT_CHECK_SIZE = 50;

export type SampleTargets = Readonly<Record<PairStratum, number>>;

export const DEFAULT_SAMPLE_TARGETS: SampleTargets = {
  narrator_fold_same: SAMPLE_PER_STRATUM,
  narrator_blocking_same: SAMPLE_PER_STRATUM,
  narrator_singleton: SAMPLE_PER_STRATUM,
  matn_exact: SAMPLE_PER_STRATUM,
  matn_near_duplicate: SAMPLE_PER_STRATUM,
  matn_false_friend: SAMPLE_PER_STRATUM,
};

export const ALL_STRATA: readonly PairStratum[] = [...NARRATOR_STRATA, ...MATN_STRATA];

/** A 32-bit seed derived from the dataset hash; the same file always draws the same sample. */
export function sampleSeed(sourceSha256: string): number {
  return fnv1a(`${SAMPLE_SEED_SALT}:${sourceSha256}`);
}

function seededKey(seed: number, key: string): number {
  return fnv1a(`${seed}:${key}`);
}

function pairKey(pair: StudyPair): string {
  return `${pair.stratum}\u0000${pair.a}\u0000${pair.b}`;
}

/** Deterministic seeded order: a shuffle whose only inputs are the seed and the pair text. */
export function seededOrder<T extends StudyPair>(pairs: readonly T[], seed: number): T[] {
  return [...pairs]
    .map((pair) => ({ pair, rank: seededKey(seed, pairKey(pair)) }))
    .sort(
      (left, right) =>
        left.rank - right.rank || (pairKey(left.pair) < pairKey(right.pair) ? -1 : 1),
    )
    .map((entry) => entry.pair);
}

export type SamplePair = StudyPair & { readonly pairId: string };

export type SampleComposition = {
  readonly stratum: PairStratum;
  readonly kind: "narrator" | "matn";
  readonly target: number;
  readonly candidates: number;
  readonly selected: number;
};

export type SampleSelection = {
  readonly pairs: readonly SamplePair[];
  readonly composition: readonly SampleComposition[];
  readonly seed: number;
  readonly requested: number;
  readonly selected: number;
  readonly shortfall: number;
};

function kindOf(stratum: PairStratum): "narrator" | "matn" {
  return stratum.startsWith("narrator_") ? "narrator" : "matn";
}

/**
 * Draw the sample stratum by stratum, then let a short stratum hand its quota to a
 * stratum with candidates left. The per-kind budget is fixed at the sum of that
 * kind's targets, so the fallback can never turn 300 into 299 narrator pairs.
 */
export function selectBlindSample(input: {
  readonly candidates: PairCandidates;
  readonly targets?: SampleTargets;
  readonly seed: number;
}): SampleSelection {
  const targets = input.targets ?? DEFAULT_SAMPLE_TARGETS;
  const requested = ALL_STRATA.reduce((sum, stratum) => sum + (targets[stratum] ?? 0), 0);
  const budgets = new Map<"narrator" | "matn", number>();
  for (const stratum of ALL_STRATA) {
    const kind = kindOf(stratum);
    budgets.set(kind, (budgets.get(kind) ?? 0) + (targets[stratum] ?? 0));
  }

  const ordered = new Map<PairStratum, StudyPair[]>();
  for (const stratum of ALL_STRATA) {
    const eligible = (input.candidates.get(stratum) ?? []).filter((pair) => pair.a !== pair.b);
    ordered.set(stratum, seededOrder(eligible, input.seed));
  }

  const selected: StudyPair[] = [];
  const used = new Set<string>();
  const selectedCount = new Map<PairStratum, number>();
  const take = (stratum: PairStratum, quota: number): number => {
    const kind = kindOf(stratum);
    const budget = budgets.get(kind) ?? 0;
    const usedOfKind = selected.filter((pair) => pair.kind === kind).length;
    let taken = 0;
    for (const pair of ordered.get(stratum) ?? []) {
      if (taken >= quota || usedOfKind + taken >= budget) break;
      const key = pairKey(pair);
      if (used.has(key)) continue;
      used.add(key);
      selected.push(pair);
      taken += 1;
    }
    selectedCount.set(stratum, (selectedCount.get(stratum) ?? 0) + taken);
    return taken;
  };

  for (const stratum of ALL_STRATA) take(stratum, targets[stratum] ?? 0);
  for (const stratum of ALL_STRATA) {
    const kind = kindOf(stratum);
    const budget = budgets.get(kind) ?? 0;
    const usedOfKind = selected.filter((pair) => pair.kind === kind).length;
    if (usedOfKind >= budget) continue;
    take(stratum, budget - usedOfKind);
  }

  const shuffled = seededOrder(selected, input.seed ^ 0x9e3779b9).map((pair, index) => ({
    ...pair,
    pairId: `P${String(index + 1).padStart(3, "0")}`,
  }));
  shuffled.sort((left, right) => (left.pairId < right.pairId ? -1 : 1));

  const composition = ALL_STRATA.map((stratum) => ({
    stratum,
    kind: kindOf(stratum),
    target: targets[stratum] ?? 0,
    candidates: (ordered.get(stratum) ?? []).length,
    selected: selectedCount.get(stratum) ?? 0,
  }));
  return {
    pairs: shuffled,
    composition,
    seed: input.seed,
    requested,
    selected: shuffled.length,
    shortfall: requested - shuffled.length,
  };
}

export const LABEL_COLUMNS = ["pair_id", "kind", "a", "b", "label", "notes"] as const;

/**
 * The labels template: every pair, empty labels. No stratum, no score — a labeller
 * holding this sheet cannot read the expected answer off the row.
 */
export function labelsTemplateRows(pairs: readonly SamplePair[]): string[][] {
  const rows: string[][] = [[...LABEL_COLUMNS]];
  for (const pair of pairs) rows.push([pair.pairId, pair.kind, pair.a, pair.b, "", ""]);
  return rows;
}

/**
 * The owner's blind sheet: a seeded subset of the 300 in seeded order, with the same
 * label-free columns. Joining it back to the preregistration is the analyst's step.
 */
export function ownerSpotCheckRows(
  pairs: readonly SamplePair[],
  seed: number,
  size = OWNER_SPOT_CHECK_SIZE,
): string[][] {
  const subset = seededOrder(
    pairs.map((pair) => ({ ...pair })),
    seed ^ 0x85ebca6b,
  ).slice(0, Math.max(0, size));
  const rows: string[][] = [[...LABEL_COLUMNS]];
  for (const pair of subset) rows.push([pair.pairId, pair.kind, pair.a, pair.b, "", ""]);
  return rows;
}

export type PreregistrationArtifact = {
  readonly version: 1;
  readonly generatedAt: string;
  readonly seed: number;
  readonly seedSalt: string;
  readonly sourceSha256: string;
  readonly requestedPairs: number;
  readonly selectedPairs: number;
  readonly shortfall: number;
  readonly selectionMethod: string;
  readonly composition: readonly SampleComposition[];
  readonly labellingLimitation: string;
  readonly pairs: readonly {
    readonly pairId: string;
    readonly kind: "narrator" | "matn";
    readonly stratum: PairStratum;
    readonly a: string;
    readonly b: string;
    readonly ref: StudyPair["ref"];
  }[];
};

/**
 * The analyst-side preregistration file. It is written before the model arm runs and
 * is the only artifact that names a stratum.
 */
export function buildPreregistrationArtifact(input: {
  readonly selection: SampleSelection;
  readonly sourceSha256: string;
  readonly generatedAt: string;
}): PreregistrationArtifact {
  return {
    version: 1,
    generatedAt: input.generatedAt,
    seed: input.selection.seed,
    seedSalt: SAMPLE_SEED_SALT,
    sourceSha256: input.sourceSha256,
    requestedPairs: input.selection.requested,
    selectedPairs: input.selection.selected,
    shortfall: input.selection.shortfall,
    selectionMethod:
      "Each stratum's candidate pairs are ordered by FNV-1a(seed:stratum:a:b), then drawn to quota with a fixed per-kind budget; a short stratum hands its quota to a stratum that still has candidates. Pair ids are assigned after a seeded shuffle of the selected set.",
    composition: input.selection.composition,
    labellingLimitation:
      "n=300 gives roughly a +/-5 point 95% interval on 90% accuracy, so a 3-point macro-F1 difference between arms is at the edge of resolution; the false-merge floor is a count and is not affected. A same-vendor review is weak review: the owner (or a second judge from a different vendor) must score at least 50 of the 300 blind, and the report states the limitation either way.",
    pairs: input.selection.pairs.map((pair) => ({
      pairId: pair.pairId,
      kind: pair.kind,
      stratum: pair.stratum,
      a: pair.a,
      b: pair.b,
      ref: pair.ref,
    })),
  };
}
