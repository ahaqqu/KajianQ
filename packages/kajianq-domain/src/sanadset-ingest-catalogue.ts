/**
 * The narrator half of the S2 plan: what the deterministic name pass writes.
 *
 * The pass is the S1 fold and blocking, nothing more. One folded name is one
 * **name cluster**, and a cluster is written as one narrator row whose `identity`
 * key is that folded name, whose canonical spelling is its most frequent surface,
 * and whose variants are the other surfaces the fold merged. That is the basis
 * the report states — `folded-name` — and it is not an identity claim: two people
 * who share a spelling are one cluster, which is why the pairs the fold could not
 * settle (two different folded names that share a blocking key, or singleton
 * names whose tokens agree) are reported as uncertain and never merged.
 *
 * Keeping the two apart matters for the invariant: merging spellings that fold to
 * the same text is normalisation, while merging two names that merely resemble
 * each other is the force-merge the corpus forbids. Only the second is reported.
 */

import {
  buildNarratorCatalogue,
  collectNarratorMentions,
  representativeSurface,
  type NarratorCatalogue,
} from "./sanadset-narrator";
import { buildNarratorPairCandidates } from "./sanadset-pairs";

/** The identity basis this pass can state: a folded name, never a resolved person. */
export const NARRATOR_IDENTITY_BASIS = "folded-name";

/** The prefix of the identity key; the store treats the whole key as opaque. */
export const NARRATOR_IDENTITY_PREFIX = "narrator:folded-name:";

/** One narrator row to upsert: a name cluster, its spellings, and its write key. */
export type NarratorPlan = {
  readonly identityKey: string;
  readonly folded: string;
  readonly canonical: string;
  readonly variants: readonly string[];
  readonly mentions: number;
};

/** A name pair the deterministic pass could not settle; it is reported, never merged. */
export type UncertainNamePair = {
  readonly stratum: "narrator_blocking_same" | "narrator_singleton";
  readonly a: string;
  readonly b: string;
};

export type NarratorPlanResult = {
  readonly narrators: readonly NarratorPlan[];
  readonly identityBasis: typeof NARRATOR_IDENTITY_BASIS;
  readonly mentions: number;
  readonly foldedNames: number;
  readonly rawSurfaces: number;
  /** Raw spellings the fold merged into a cluster (raw surfaces minus clusters). */
  readonly foldedVariants: number;
  /** Mentions whose folded name occurs more than once: coverage, not identity. */
  readonly coverageRate: number;
  readonly uncertainPairs: readonly UncertainNamePair[];
  readonly uncertainByStratum: Readonly<Record<string, number>>;
};

/** The identity key of a folded name — the caller-supplied natural key of the row. */
export function narratorIdentityKey(folded: string): string {
  return `${NARRATOR_IDENTITY_PREFIX}${folded}`;
}

/** A prepared row as this pass reads it: its folded chain and the raw chain beside it. */
export type ChainRowNames = {
  readonly chain: readonly string[];
  readonly rawChain: readonly string[];
};

/** One plan per folded name, sorted by name so the write order is the plan's order. */
export function planNarrators(
  rows: readonly ChainRowNames[],
  catalogue: NarratorCatalogue = buildNarratorCatalogue(collectNarratorMentions(rows)),
): NarratorPlanResult {
  const narrators: NarratorPlan[] = [];
  for (const folded of [...catalogue.clusters.keys()].sort()) {
    const cluster = catalogue.clusters.get(folded);
    if (cluster === undefined) continue;
    const canonical = representativeSurface(catalogue, folded) ?? folded;
    narrators.push({
      identityKey: narratorIdentityKey(folded),
      folded,
      canonical,
      variants: cluster.surfaces.filter((surface) => surface !== canonical),
      mentions: cluster.mentions,
    });
  }

  // Only the two strata that ask "are these two names one narrator?" are uncertain.
  // `narrator_fold_same` is the fold's own work — those spellings are recorded as
  // variants of one cluster, and reporting them as a question would double-count.
  const uncertainPairs: UncertainNamePair[] = [];
  const uncertainByStratum: Record<string, number> = {};
  const pools = buildNarratorPairCandidates(catalogue);
  for (const stratum of ["narrator_blocking_same", "narrator_singleton"] as const) {
    const pairs = pools.get(stratum) ?? [];
    uncertainByStratum[stratum] = pairs.length;
    for (const pair of pairs) uncertainPairs.push({ stratum, a: pair.a, b: pair.b });
  }
  uncertainPairs.sort(
    (left, right) =>
      left.stratum.localeCompare(right.stratum) ||
      left.a.localeCompare(right.a) ||
      left.b.localeCompare(right.b),
  );

  return {
    narrators,
    identityBasis: NARRATOR_IDENTITY_BASIS,
    mentions: catalogue.stats.mentions,
    foldedNames: catalogue.stats.foldedDistinct,
    rawSurfaces: catalogue.stats.rawDistinct,
    foldedVariants: catalogue.stats.foldedVariants,
    coverageRate: catalogue.stats.nonSingletonMentionRate,
    uncertainPairs,
    uncertainByStratum,
  };
}
