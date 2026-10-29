/**
 * Turn a completed run into the study's fact set.
 *
 * The arithmetic here is the report's only source of numbers: rates are derived from
 * counted rows, never re-derived by a reader, and every rate carries the denominator it
 * was computed over.
 */

import {
  evaluateGates,
  SLICE_BOOKS,
  type ArmFacts,
  type CascadeResult,
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
  readonly source: {
    readonly fileName: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly recordsRead: number;
  };
  readonly stats: PrepareStats;
  readonly prepared: readonly PreparedRow[];
  /** Rows that declare a chain: slice rows minus the `No SANAD` rows. */
  readonly chainBearing: number;
  readonly cascade: CascadeResult;
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
  /** Calls the arm would issue for this run: the pre-registered sample plus the band. */
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
  const groups = input.cascade.groups.length;
  const quarantineByRule: Record<string, number> = {};
  for (const row of input.quarantined)
    quarantineByRule[row.rule] = (quarantineByRule[row.rule] ?? 0) + 1;
  const bandRows = counts.bandRows;
  const callsNeeded = input.callsNeeded;

  return {
    schemaVersion: 1,
    runId: input.runId,
    command: input.command,
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
      groups,
      distinctMatns: groups,
      chainsPerChild: groups === 0 ? 0 : input.chainBearing / groups,
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
      matnRows: bandRows,
      narratorPairs: input.catalogue.stats.candidatePairs,
      narratorNames: input.catalogue.stats.bandNames,
      callsNeeded,
      callsBudgeted: Math.min(input.ceiling, callsNeeded),
      ceiling: input.ceiling,
    },
    quarantine: { total: input.quarantined.length, byRule: quarantineByRule },
    modelArm: input.arm,
    sample: input.sample,
    gates: evaluateGates({
      narratorRate: input.catalogue.stats.resolutionRate,
      quarantineShare: input.chainBearing === 0 ? 0 : input.quarantined.length / input.chainBearing,
      spendMicroUsd: input.arm.spendMicroUsd,
      capMicroUsd: input.capMicroUsd,
      armRan: input.arm.ran,
    }),
    limits: input.limits,
    timings: input.timings,
  };
}
