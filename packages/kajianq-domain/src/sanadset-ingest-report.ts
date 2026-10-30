/**
 * The pilot's report: the `IngestionReport` contract plus the facts the §9.4 report
 * owes — match rate with its scope, narrator coverage with its basis, quarantine by
 * rule, the write counts a rerun actually produced, and a cost of exactly zero (this
 * path makes no model call).
 *
 * The document is built for a dry run too, so the plan the operator reads and the run
 * that follows cannot drift apart; `sanadset-ingest-report-write.ts` owns the file I/O.
 */

import type { IngestionReport } from "@app/contracts";
import type { UncertainNamePair } from "./sanadset-ingest-catalogue";
import {
  PLAN_SAMPLE_GROUPS,
  PLAN_SAMPLE_QUARANTINE,
  sampleArtifactGroups,
  sampleQuarantineRows,
} from "./sanadset-ingest-plan-artifact";
import type {
  BuildReportOptions,
  PilotFacts,
  WriteCounts,
  WriteFacts,
} from "./sanadset-ingest-report-types";

export type {
  BuildReportOptions,
  PilotFacts,
  PilotGateFacts,
  PilotSourceFacts,
  WriteFacts,
} from "./sanadset-ingest-report-types";

/** The document the run writes: the contract's report plus the pilot's facts. */
export type PilotReportDocument = {
  readonly report: IngestionReport;
  readonly pilot: PilotFacts;
  /** The name pairs the deterministic pass refused to merge: reported, never written. */
  readonly uncertainNarratorPairs: readonly UncertainNamePair[];
};

const ZERO_COUNTS: WriteCounts = { created: 0, updated: 0, unchanged: 0, deleted: 0 };

/** The report's own limits: every one is a scope a reader could otherwise over-read. */
export const PILOT_LIMITS: readonly string[] = [
  "The match rate is measured against one collection's stored children, not the full corpus, and it is a property of the children this run read: an empty corpus reports zero by construction, a seeded corpus reports what its seed contains, and the plan artifact names every target and every matched child's text digest so a seeded run is reproducible.",
  "Narrator rows are Name clusters on the deterministic fold, not resolved Narrators: two people who share a spelling are one row, and the pairs the fold could not settle are reported unmerged.",
  "No model call is made, so the band is not adjudicated and each band-unresolved matn becomes its own child.",
  "New children carry NULL embeddings and stay lexically retrievable; embedding them is a later, paid run.",
  "A matn group that ties between two stored children, whose candidate search hit its cap, or whose containment is only a fragment of a longer narration is quarantined whole and its chains are not written; the plan artifact carries the rule and the measured reason.",
  "A rerun reconciles only this pilot's own rows — children under its parent document and chains carrying its source prefix. Narrator rows stay in the catalogue once written.",
];

export function buildPilotReport(options: BuildReportOptions): PilotReportDocument {
  const { plan, outcome, source, gate } = options;
  const write: WriteFacts = outcome ?? {
    parentId: null,
    children: ZERO_COUNTS,
    chains: ZERO_COUNTS,
    narratorsUpserted: 0,
  };
  const facts: PilotFacts = {
    schemaVersion: 1,
    runId: options.runId,
    command: options.command,
    dryRun: options.dryRun,
    collection: plan.scope.collection,
    book: plan.scope.book,
    source,
    slice: {
      rows: plan.slice.rows,
      noSanad: plan.slice.noSanad,
      prepared: plan.slice.prepared,
      quarantined: plan.slice.quarantined,
      quarantinedByRule: plan.slice.quarantinedByRule,
    },
    narrator: {
      identityBasis: plan.narrators.identityBasis,
      mentions: plan.narrators.mentions,
      foldedNames: plan.narrators.foldedNames,
      rawSurfaces: plan.narrators.rawSurfaces,
      foldedVariants: plan.narrators.foldedVariants,
      resolutionRate: plan.narrators.coverageRate,
      upserted: write.narratorsUpserted,
      variantsRecorded: plan.narrators.narrators.reduce(
        (total, narrator) => total + narrator.variants.length,
        0,
      ),
      uncertainPairs: plan.narrators.uncertainPairs.length,
      uncertainByStratum: plan.narrators.uncertainByStratum,
    },
    matn: {
      groups: plan.groups.length,
      matchedGroups: plan.children.matched,
      ambiguousGroups: plan.children.ambiguous,
      fragmentaryGroups: plan.children.fragmentary,
      newChildren: plan.children.created.length,
      storedChildrenCompared: plan.children.compared,
      truncatedSearches: plan.children.truncatedSearches,
      matchRate: {
        scope: plan.matchRate.scope,
        matchedRows: plan.matchRate.matchedRows,
        rows: plan.matchRate.rows,
        refusedRows: plan.matchRate.refusedRows,
        value: plan.matchRate.value,
      },
    },
    chains: { planned: plan.chains.length },
    plan: {
      artifactPath: options.planArtifactPath,
      groups: plan.groups.length,
      byTarget: options.planArtifact.counts.byTarget,
      sample: sampleArtifactGroups(options.planArtifact),
      quarantineSample: sampleQuarantineRows(plan.quarantine.rows),
      sampleLimit: PLAN_SAMPLE_GROUPS,
      quarantineSampleLimit: PLAN_SAMPLE_QUARANTINE,
    },
    write: { children: write.children, chains: write.chains },
    quarantine: { total: plan.quarantine.total, byRule: plan.quarantine.byRule },
    gate,
    cost: { modelCalls: 0, costMicroUsd: 0 },
    limits: PILOT_LIMITS,
    timings: { startedAt: options.startedAt, finishedAt: options.finishedAt },
  };
  const report: IngestionReport = {
    runId: options.runId,
    sourceKey: `sanadset:${plan.scope.collection}:${source.sha256.slice(0, 12)}`,
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    parentsWritten: write.parentId === null ? 0 : 1,
    childrenWritten: write.children.created,
    quarantined: plan.quarantine.total,
    costMicroUsd: 0,
    llmCalls: [],
    details: {
      collection: plan.scope.collection,
      dryRun: options.dryRun,
      narration: {
        mentions: facts.narrator.mentions,
        foldedNames: facts.narrator.foldedNames,
        resolutionRate: facts.narrator.resolutionRate,
        identityBasis: facts.narrator.identityBasis,
        uncertainPairs: facts.narrator.uncertainPairs,
      },
      matchRate: facts.matn.matchRate,
      chains: { planned: facts.chains.planned, written: facts.write.chains.created },
      quarantineByRule: facts.quarantine.byRule,
      gate: facts.gate,
    },
  };
  return { report, pilot: facts, uncertainNarratorPairs: plan.narrators.uncertainPairs };
}
