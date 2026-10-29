/**
 * The shapes the study report is assembled from.
 *
 * `MatchRate` carries its scope by construction so no reader can quote the in-slice
 * figure as if it were the corpus reconciliation rate; `StudyGate` carries the reason
 * a gate is not measured, so an unmeasured gate cannot be read as a pass.
 */

import type { CostRecord, IngestionReport } from "@app/contracts";
import type { ArmEstimate, ArmStatus } from "./sanadset-arm";
import type { NarratorStats } from "./sanadset-narrator";
import type { PrepareStats } from "./sanadset-prepare";

export type MatchRate = {
  /** `slice-internal` measures coalescing inside the slice; `v1-corpus` the reconciliation target. */
  readonly scope: "slice-internal" | "v1-corpus";
  readonly matchedRows: number;
  readonly rows: number;
  readonly value: number;
};

export type GateStatus = "pass" | "fail" | "not-measured";

export type StudyGate = {
  readonly id: string;
  readonly requirement: string;
  readonly threshold: string;
  readonly measured: string | null;
  readonly status: GateStatus;
  readonly reason: string;
};

export type ArmFacts = ArmStatus & {
  readonly ran: boolean;
  readonly stopReason: "not-requested" | "key-absent" | "ran" | "ceiling-reached";
  readonly requests: number;
  readonly calls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly estimatedTokens: boolean;
  readonly spendMicroUsd: number;
  readonly estimate: ArmEstimate | null;
  readonly samplePredictions: number;
};

export type SampleStratumFacts = {
  readonly stratum: string;
  readonly kind: "narrator" | "matn";
  readonly target: number;
  readonly candidates: number;
  readonly selected: number;
};

export type StudyFacts = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly command: string;
  readonly source: {
    readonly fileName: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly recordsRead: number;
  };
  readonly slice: {
    readonly books: readonly string[];
    readonly rows: number;
    readonly noSanad: number;
    readonly quarantined: number;
    readonly prepared: number;
    readonly repeatedNameChains: number;
    readonly unbalancedTagRows: number;
    readonly byBook: PrepareStats["byBook"];
  };
  readonly narrator: NarratorStats;
  readonly matn: {
    readonly preparedRows: number;
    readonly groups: number;
    readonly distinctMatns: number;
    readonly chainsPerChild: number;
    readonly matchRate: MatchRate;
    readonly byBook: Readonly<Record<string, MatchRate>>;
    readonly byKind: Readonly<Record<string, number>>;
    readonly candidateCapHits: number;
  };
  readonly band: {
    readonly matnRows: number;
    readonly narratorPairs: number;
    readonly narratorNames: number;
    readonly callsNeeded: number;
    readonly callsBudgeted: number;
    readonly ceiling: number;
  };
  readonly quarantine: {
    readonly total: number;
    readonly byRule: Readonly<Record<string, number>>;
  };
  readonly modelArm: ArmFacts;
  readonly sample: {
    readonly seed: number;
    readonly requested: number;
    readonly selected: number;
    readonly shortfall: number;
    readonly composition: readonly SampleStratumFacts[];
    readonly labelsPresent: boolean;
  };
  readonly gates: readonly StudyGate[];
  readonly limits: readonly string[];
  readonly timings: {
    readonly startedAt: number;
    readonly finishedAt: number;
    readonly wallClockMs: number;
  };
};

export type StudyReportDocument = {
  readonly report: IngestionReport;
  readonly study: StudyFacts;
};

export type ReportInput = {
  readonly facts: StudyFacts;
  /** The arm's per-call cost records in the persisted contract shape. */
  readonly costRecords: readonly CostRecord[];
  /** Quarantined rows counted by the report contract (never force-merged). */
  readonly quarantined: number;
};
