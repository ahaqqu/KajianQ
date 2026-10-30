/**
 * The report's facts and the options that build them. They live apart from the
 * builder so the builder reads the plan artifact's values and this module owns the
 * document's shape.
 */

import type { IngestPlan } from "./sanadset-ingest-plan";
import type { PlanArtifact, PlanGroupRecord } from "./sanadset-ingest-plan-artifact";
import type { WriteCounts } from "./sanadset-ingest-reconcile";
import type { QuarantinedRow } from "./sanadset-prepare";

export type { WriteCounts } from "./sanadset-ingest-reconcile";

/** What the write path did (all zero on a dry run): upserts plus reconciliation deletes. */
export type WriteFacts = {
  readonly parentId: string | null;
  readonly children: WriteCounts;
  readonly chains: WriteCounts;
  /** Name-cluster rows upserted; the catalogue is not reconciled. */
  readonly narratorsUpserted: number;
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
    readonly resolutionRate: number;
    readonly upserted: number;
    readonly variantsRecorded: number;
    readonly uncertainPairs: number;
    readonly uncertainByStratum: Readonly<Record<string, number>>;
  };
  readonly matn: {
    readonly groups: number;
    readonly matchedGroups: number;
    readonly ambiguousGroups: number;
    /** Groups whose best candidate was only a fragment of a longer narration. */
    readonly fragmentaryGroups: number;
    readonly newChildren: number;
    readonly storedChildrenCompared: number;
    readonly truncatedSearches: number;
    readonly matchRate: {
      readonly scope: string;
      readonly matchedRows: number;
      readonly rows: number;
      readonly refusedRows: number;
      readonly value: number;
    };
  };
  readonly chains: { readonly planned: number };
  /**
   * The plan the run would execute, sampled from the artifact. `artifactPath` is the
   * full plan; `sample` holds the targets a reviewer must inspect first.
   */
  readonly plan: {
    readonly artifactPath: string | null;
    readonly groups: number;
    readonly byTarget: Readonly<Record<string, number>>;
    readonly sample: readonly PlanGroupRecord[];
    readonly quarantineSample: readonly QuarantinedRow[];
    readonly sampleLimit: number;
    readonly quarantineSampleLimit: number;
  };
  /** The rows this run created, updated, left unchanged and deleted. */
  readonly write: {
    readonly children: WriteCounts;
    readonly chains: WriteCounts;
  };
  readonly quarantine: {
    readonly total: number;
    readonly byRule: Readonly<Record<string, number>>;
  };
  readonly gate: PilotGateFacts;
  readonly cost: { readonly modelCalls: number; readonly costMicroUsd: number };
  readonly limits: readonly string[];
  readonly timings: { readonly startedAt: number; readonly finishedAt: number };
};

export type BuildReportOptions = {
  readonly runId: string;
  readonly command: string;
  readonly dryRun: boolean;
  readonly plan: IngestPlan;
  /** The plan artifact the run wrote; the report samples it and names its path. */
  readonly planArtifact: PlanArtifact;
  readonly planArtifactPath: string;
  readonly source: PilotSourceFacts;
  readonly gate: PilotGateFacts;
  readonly outcome: WriteFacts | null;
  readonly startedAt: number;
  readonly finishedAt: number;
};
