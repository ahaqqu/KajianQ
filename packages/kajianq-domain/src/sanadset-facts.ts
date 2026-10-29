/**
 * Turn a completed run into the study's fact set.
 *
 * The arithmetic here is the report's only source of numbers: rates are derived from
 * counted rows, never re-derived by a reader, and every rate carries the denominator it
 * was computed over. Two populations that were mixed are kept apart here — the children
 * an isnad could attach to (book-scoped, quarantine-excluded) and every row that declares
 * an isnad — because a ratio computed across both describes neither.
 */

import {
  countByRule,
  evaluateGates,
  SLICE_BOOKS,
  type ArmFacts,
  type CascadeResult,
  type CrossBookJoins,
  type MatchRate,
  type NarratorCatalogue,
  type PrepareStats,
  type PreparedRow,
  type QuarantinedRow,
  type SampleStratumFacts,
  type SliceBook,
  type StudyFacts,
} from "./sanadset-core";

const JOINED_KINDS = new Set(["exact", "folded", "trigram", "model-same"]);

export type FactsInput = {
  readonly runId: string;
  readonly command: string;
  readonly artifactsDir: string;
  readonly source: {
    readonly fileName: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly recordsRead: number;
  };
  readonly stats: PrepareStats;
  readonly prepared: readonly PreparedRow[];
  /** Rows that declare an isnad: slice rows minus the `No SANAD` rows. */
  readonly isnadBearing: number;
  readonly cascade: CascadeResult;
  /** The same cascade run against an unscoped book: what the book scope prevents. */
  readonly crossBook: CrossBookJoins;
  readonly catalogue: NarratorCatalogue;
  readonly sample: {
    readonly seed: number;
    readonly requested: number;
    readonly selected: number;
    readonly shortfall: number;
    readonly composition: readonly SampleStratumFacts[];
    readonly labelsPresent: boolean;
  };
  readonly quarantined: readonly QuarantinedRow[];
  readonly arm: ArmFacts;
  readonly ceiling: number;
  /** Calls the run plans: the pre-registered sample plus one per band row, uncapped. */
  readonly callsNeeded: number;
  readonly capMicroUsd: number;
  readonly limits: readonly string[];
  readonly timings: {
    readonly startedAt: number;
    readonly finishedAt: number;
    readonly wallClockMs: number;
  };
};

function rate(scope: MatchRate["scope"], matchedRows: number, rows: number): MatchRate {
  return { scope, matchedRows, rows, value: rows === 0 ? 0 : matchedRows / rows };
}

/** Build the report facts from a completed run. */
export function buildStudyFacts(input: FactsInput): StudyFacts {
  const counts = input.cascade.counts;
  const bookByRow = new Map<number, SliceBook>();
  for (const row of input.prepared) bookByRow.set(row.rowIndex, row.book);
  const rowsByBook: Record<string, number> = {};
  const joinedByBook: Record<string, number> = {};
  for (const book of SLICE_BOOKS) {
    rowsByBook[book] = 0;
    joinedByBook[book] = 0;
  }
  for (const decision of input.cascade.decisions) {
    const book = bookByRow.get(decision.rowIndex);
    if (book === undefined) continue;
    rowsByBook[book] = (rowsByBook[book] ?? 0) + 1;
    if (JOINED_KINDS.has(decision.kind)) joinedByBook[book] = (joinedByBook[book] ?? 0) + 1;
  }

  const byKind: Record<string, number> = {
    exact: counts.exact,
    folded: counts.folded,
    trigram: counts.trigram,
    "model-same": counts.modelSame,
    "model-different": counts.modelDifferent,
    "band-unresolved": counts.bandUnresolved,
    "no-match": counts.noMatch,
    quarantined: counts.quarantined,
  };
  const children = input.cascade.groups.length;
  const distinctMatnTexts = new Set(input.prepared.map((row) => row.normalizedMatn)).size;
  const quarantineByRule = countByRule(input.quarantined);
  // Rows an isnad could still attach to: prepared and not held back by the cascade.
  const attachableRows = input.prepared.length - input.cascade.quarantined.length;

  return {
    schemaVersion: 1,
    runId: input.runId,
    command: input.command,
    artifactsDir: input.artifactsDir,
    source: input.source,
    slice: {
      books: [...SLICE_BOOKS],
      rows: input.stats.rows,
      noSanad: input.stats.noSanad,
      quarantined: input.stats.quarantined,
      prepared: input.prepared.length,
      repeatedNameChains: input.stats.repeatedNameChains,
      unbalancedTagRows: input.stats.unbalancedTagRows,
      byBook: input.stats.byBook,
    },
    narrator: input.catalogue.stats,
    matn: {
      preparedRows: input.prepared.length,
      children,
      distinctMatnTexts,
      bookScope: input.cascade.bookScope,
      crossBook: input.crossBook,
      attachableRows,
      isnadBearingRows: input.isnadBearing,
      // The sizing input: rows an isnad can attach to, over the children it can attach to.
      chainsPerChild: children === 0 ? 0 : attachableRows / children,
      // The same quotient over every isnad-bearing row, quarantine included: reported and
      // labelled, never quoted as the sizing input.
      chainsPerChildAllBearing: children === 0 ? 0 : input.isnadBearing / children,
      matchRate: rate("slice-internal", counts.joinedExisting, input.prepared.length),
      byBook: Object.fromEntries(
        SLICE_BOOKS.map((book) => [
          book,
          rate("slice-internal", joinedByBook[book] ?? 0, rowsByBook[book] ?? 0),
        ]),
      ),
      byKind,
      candidateCapHits: counts.candidateCapHits,
    },
    band: {
      matnRows: counts.bandAdjudicated,
      matnBandLower: input.cascade.thresholds.band,
      matnBandUpper: input.cascade.thresholds.auto,
      ambiguousQuarantined: counts.ambiguousQuarantined,
      narratorPairs: input.catalogue.stats.candidatePairs,
      narratorNames: input.catalogue.stats.bandNames,
      sampleCalls: input.sample.selected,
      callsNeeded: input.callsNeeded,
      callsBudgeted: Math.min(input.ceiling, input.callsNeeded),
      ceiling: input.ceiling,
    },
    quarantine: { total: input.quarantined.length, byRule: quarantineByRule },
    modelArm: input.arm,
    sample: input.sample,
    gates: evaluateGates({
      narratorCoverage: input.catalogue.stats.nonSingletonMentionRate,
      quarantineShare: input.isnadBearing === 0 ? 0 : input.quarantined.length / input.isnadBearing,
      spendMicroUsd: input.arm.spendMicroUsd,
      capMicroUsd: input.capMicroUsd,
      armRan: input.arm.ran,
    }),
    limits: input.limits,
    timings: input.timings,
  };
}
