/**
 * The pilot's report: the `IngestionReport` contract plus the facts the §9.4 report
 * owes — match rate with its scope, narrator coverage with its basis, quarantine by
 * rule, and a cost of exactly zero (this path makes no model call).
 *
 * The document is built for a dry run too, so the plan the operator reads and the run
 * that follows cannot drift apart; `sanadset-ingest-report-write.ts` owns the file I/O.
 */

import type { IngestionReport } from "@app/contracts";
import type { UncertainNamePair } from "./sanadset-ingest-catalogue";
import type { IngestPlan } from "./sanadset-ingest-plan";

/** The counts the write path produced (or zeroed for a dry run). */
export type WriteFacts = {
  readonly parentId: string | null;
  readonly childrenCreated: number;
  readonly chainsWritten: number;
  readonly narratorsWritten: number;
};

export type PilotSourceFacts = {
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly recordsRead: number;
};

export type PilotGateFacts = {
  readonly mode: string;
  readonly label: string | null;
  readonly reasons: readonly string[];
};

export type PilotFacts = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly command: string;
  readonly dryRun: boolean;
  readonly collection: string;
  readonly book: string;
  readonly source: PilotSourceFacts;
  readonly slice: {
    readonly rows: number;
    readonly noSanad: number;
    readonly prepared: number;
    readonly quarantined: number;
    readonly quarantinedByRule: Readonly<Record<string, number>>;
  };
  readonly narrator: {
    readonly identityBasis: string;
    readonly mentions: number;
    readonly foldedNames: number;
    readonly rawSurfaces: number;
    readonly foldedVariants: number;
    readonly coverageRate: number;
    readonly written: number;
    readonly variantsRecorded: number;
    readonly uncertainPairs: number;
    readonly uncertainByStratum: Readonly<Record<string, number>>;
  };
  readonly matn: {
    readonly groups: number;
    readonly matchedGroups: number;
    readonly ambiguousGroups: number;
    readonly newChildren: number;
    readonly createdChildren: number;
    readonly storedChildrenCompared: number;
    readonly truncatedSearches: number;
    readonly matchRate: {
      readonly scope: string;
      readonly matchedRows: number;
      readonly rows: number;
      readonly value: number;
    };
  };
  readonly chains: { readonly planned: number; readonly written: number };
  readonly quarantine: {
    readonly total: number;
    readonly byRule: Readonly<Record<string, number>>;
  };
  readonly gate: PilotGateFacts;
  readonly cost: { readonly modelCalls: number; readonly costMicroUsd: number };
  readonly limits: readonly string[];
  readonly timings: { readonly startedAt: number; readonly finishedAt: number };
};

export type PilotReportDocument = {
  readonly report: IngestionReport;
  readonly pilot: PilotFacts;
  /** The name pairs the deterministic pass refused to merge: reported, never written. */
  readonly uncertainNarratorPairs: readonly UncertainNamePair[];
};

export type BuildReportOptions = {
  readonly runId: string;
  readonly command: string;
  readonly dryRun: boolean;
  readonly plan: IngestPlan;
  readonly source: PilotSourceFacts;
  readonly gate: PilotGateFacts;
  readonly outcome: WriteFacts | null;
  readonly startedAt: number;
  readonly finishedAt: number;
};

/** The report's own limits: every one is a scope a reader could otherwise over-read. */
export const PILOT_LIMITS: readonly string[] = [
  "The match rate is measured against one collection's stored children, not the full corpus.",
  "Narrator rows are name clusters on the deterministic fold, not resolved identities: two people who share a spelling are one row, and the pairs the fold could not settle are reported unmerged.",
  "No model call is made, so the band is not adjudicated and each band-unresolved matn becomes its own child.",
  "New children carry NULL embeddings and stay lexically retrievable; embedding them is a later, paid run.",
  "A matn group that ties between two stored children is quarantined whole and its chains are not written.",
];

export function buildPilotReport(options: BuildReportOptions): PilotReportDocument {
  const { plan, outcome, source, gate } = options;
  const written = outcome?.chainsWritten ?? 0;
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
      quarantined: plan.quarantine.total,
      quarantinedByRule: plan.quarantine.byRule,
    },
    narrator: {
      identityBasis: plan.narrators.identityBasis,
      mentions: plan.narrators.mentions,
      foldedNames: plan.narrators.foldedNames,
      rawSurfaces: plan.narrators.rawSurfaces,
      foldedVariants: plan.narrators.foldedVariants,
      coverageRate: plan.narrators.coverageRate,
      written: outcome?.narratorsWritten ?? 0,
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
      newChildren: plan.children.created.length,
      createdChildren: outcome?.childrenCreated ?? 0,
      storedChildrenCompared: plan.children.compared,
      truncatedSearches: plan.children.truncatedSearches,
      matchRate: {
        scope: plan.matchRate.scope,
        matchedRows: plan.matchRate.matchedRows,
        rows: plan.matchRate.rows,
        value: plan.matchRate.value,
      },
    },
    chains: { planned: plan.chains.length, written },
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
    parentsWritten: outcome?.parentId === null || outcome?.parentId === undefined ? 0 : 1,
    childrenWritten: outcome?.childrenCreated ?? 0,
    quarantined: plan.quarantine.total,
    costMicroUsd: 0,
    llmCalls: [],
    details: {
      collection: plan.scope.collection,
      dryRun: options.dryRun,
      narration: {
        mentions: facts.narrator.mentions,
        foldedNames: facts.narrator.foldedNames,
        coverageRate: facts.narrator.coverageRate,
        identityBasis: facts.narrator.identityBasis,
        uncertainPairs: facts.narrator.uncertainPairs,
      },
      matchRate: facts.matn.matchRate,
      chains: facts.chains,
      quarantineByRule: facts.slice.quarantinedByRule,
      gate: facts.gate,
    },
  };
  return { report, pilot: facts, uncertainNarratorPairs: plan.narrators.uncertainPairs };
}
