/**
 * The dry run's plan artifact: what every matn group would attach to, and why a
 * quarantined row was held back.
 *
 * The report is a summary; this artifact is the plan itself, written before any
 * store write so the operator can read the group→target assignments a real run
 * would perform. Every group carries its target — child id, score and how — and a
 * matched child carries the digest of its immutable text, so a matched pair is
 * reproducible from the artifact alone. Every quarantine row carries its rule and
 * detail, including the two children of an ambiguity and the fragment test a
 * containment failed. The report embeds a bounded sample of both.
 *
 * The artifact holds corpus text (a matn preview), so its path is guarded like the
 * report's: it is written outside every working tree of this repository.
 */

import { matnKeyOf } from "./sanadset-ingest-content";
import type { ExistingChildRow, MatnTarget } from "./sanadset-ingest-match";
import type { GroupPlan, IngestPlan } from "./sanadset-ingest-plan-types";
import type { QuarantinedRow } from "./sanadset-prepare";

export const PLAN_SCHEMA_VERSION = 1;

/** How much raw matn the artifact carries per group; the full length is beside it. */
export const PLAN_MATN_PREVIEW_CHARS = 160;

/** How many group targets the report embeds beside the full artifact. */
export const PLAN_SAMPLE_GROUPS = 10;

/** How many quarantine rows the report embeds, round-robin across their rules. */
export const PLAN_SAMPLE_QUARANTINE = 12;

export type PlanSourceFacts = {
  readonly fileName: string;
  readonly sha256: string;
  readonly recordsRead: number;
};

/** One group's target, flattened for reading: no consumer has to know MatnTarget's union. */
export type PlanTargetRecord = {
  readonly kind: MatnTarget["kind"];
  readonly childId?: string;
  /** The immutable text identity of a matched or refused child. */
  readonly childTextSha256?: string;
  readonly childChars?: number;
  readonly how?: "exact" | "folded" | "trigram" | "containment";
  readonly score?: number;
  readonly reason?: string;
  readonly candidates?: readonly string[];
  readonly candidateCount?: number;
  readonly cap?: number;
};

export type PlanGroupRecord = {
  readonly groupId: number;
  readonly representativeRowIndex: number;
  readonly hadithNumber: string;
  readonly matnKey: string;
  readonly memberRows: readonly number[];
  readonly matnChars: number;
  readonly matnTokens: number;
  readonly matnPreview: string;
  readonly target: PlanTargetRecord;
};

export type PlanArtifact = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly dryRun: boolean;
  readonly scope: { readonly collection: string; readonly book: string };
  readonly source: PlanSourceFacts | null;
  readonly thresholds: IngestPlan["thresholds"];
  readonly counts: {
    readonly groups: number;
    readonly byTarget: Readonly<Record<MatnTarget["kind"], number>>;
    readonly matchedGroups: number;
    readonly fragmentaryGroups: number;
    readonly ambiguousGroups: number;
    readonly truncatedSearches: number;
    readonly newChildren: number;
    readonly chains: number;
    readonly quarantine: {
      readonly total: number;
      readonly byRule: Readonly<Record<string, number>>;
    };
  };
  /** Every group, in cascade order. */
  readonly groups: readonly PlanGroupRecord[];
  /** Every quarantined row, in prepare → cascade → refused order. */
  readonly quarantine: readonly QuarantinedRow[];
};

export type BuildPlanArtifactOptions = {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly plan: IngestPlan;
  /** The children the corpus read returned, for the digests of matched texts. */
  readonly children: readonly ExistingChildRow[];
  readonly source?: PlanSourceFacts;
};

function preview(rawMatn: string): string {
  const text = rawMatn.trim();
  return text.length > PLAN_MATN_PREVIEW_CHARS
    ? `${text.slice(0, PLAN_MATN_PREVIEW_CHARS - 1)}…`
    : text;
}

/** Every target kind is present, zero included: a reader can diff two artifacts. */
function targetCounts(groups: readonly GroupPlan[]): Readonly<Record<MatnTarget["kind"], number>> {
  const counts = { existing: 0, new: 0, ambiguous: 0, fragmentary: 0, truncated: 0 };
  for (const group of groups) counts[group.target.kind] += 1;
  return counts;
}

function childFacts(
  childId: string,
  children: ReadonlyMap<string, ExistingChildRow>,
): Pick<PlanTargetRecord, "childTextSha256" | "childChars"> {
  const child = children.get(childId);
  if (child === undefined) return {};
  return { childTextSha256: matnKeyOf(child.textRaw), childChars: child.textRaw.length };
}

function targetRecord(
  target: MatnTarget,
  children: ReadonlyMap<string, ExistingChildRow>,
): PlanTargetRecord {
  switch (target.kind) {
    case "new":
      return { kind: "new" };
    case "existing":
      return {
        kind: "existing",
        childId: target.childId,
        how: target.how,
        score: target.score,
        ...childFacts(target.childId, children),
      };
    case "fragmentary":
      return {
        kind: "fragmentary",
        childId: target.childId,
        how: target.how,
        score: target.score,
        reason: target.reason,
        ...childFacts(target.childId, children),
      };
    case "ambiguous":
      return { kind: "ambiguous", score: target.score, candidates: [...target.candidates] };
    case "truncated":
      return { kind: "truncated", candidateCount: target.candidates, cap: target.cap };
  }
}

function groupRecord(
  group: GroupPlan,
  children: ReadonlyMap<string, ExistingChildRow>,
): PlanGroupRecord {
  const tokens = group.foldedMatn === "" ? [] : group.foldedMatn.split(" ").filter(Boolean);
  return {
    groupId: group.groupId,
    representativeRowIndex: group.representativeRowIndex,
    hadithNumber: group.hadithNumber,
    matnKey: group.matnKey,
    memberRows: [...group.memberRows],
    matnChars: group.foldedMatn.length,
    matnTokens: tokens.length,
    matnPreview: preview(group.rawMatn),
    target: targetRecord(group.target, children),
  };
}

/** Build the full artifact: every group's target and every quarantine row. */
export function buildPlanArtifact(options: BuildPlanArtifactOptions): PlanArtifact {
  const { plan } = options;
  const children = new Map(options.children.map((child) => [child.id, child]));
  const groups = plan.groups.map((group) => groupRecord(group, children));
  const byTarget = targetCounts(plan.groups);
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    runId: options.runId,
    dryRun: options.dryRun,
    scope: { collection: plan.scope.collection, book: plan.scope.book },
    source: options.source ?? null,
    thresholds: plan.thresholds,
    counts: {
      groups: plan.groups.length,
      byTarget,
      matchedGroups: plan.children.matched,
      fragmentaryGroups: plan.children.fragmentary,
      ambiguousGroups: plan.children.ambiguous,
      truncatedSearches: plan.children.truncatedSearches,
      newChildren: plan.children.created.length,
      chains: plan.chains.length,
      quarantine: { total: plan.quarantine.total, byRule: plan.quarantine.byRule },
    },
    groups,
    quarantine: plan.quarantine.rows,
  };
}

/**
 * The report's group sample: the targets a reader must inspect first — matched,
 * fragmentary, ambiguous and truncated — up to `limit`, carrying the child digests.
 * A plan with only new children shows the first few so the shape is still visible.
 */
export function sampleArtifactGroups(
  artifact: PlanArtifact,
  limit: number = PLAN_SAMPLE_GROUPS,
): readonly PlanGroupRecord[] {
  return selectGroups(artifact.groups, limit);
}

function selectGroups(
  records: readonly PlanGroupRecord[],
  limit: number,
): readonly PlanGroupRecord[] {
  const noteworthy = records.filter((record) => record.target.kind !== "new");
  return noteworthy.length > 0 ? noteworthy.slice(0, limit) : records.slice(0, Math.min(limit, 5));
}

/**
 * The report's quarantine sample: round-robin across rules, so one rule's many rows
 * cannot hide another rule's detail. Order inside a rule follows the plan.
 */
export function sampleQuarantineRows(
  rows: readonly QuarantinedRow[],
  limit: number = PLAN_SAMPLE_QUARANTINE,
): readonly QuarantinedRow[] {
  const byRule = new Map<string, QuarantinedRow[]>();
  for (const row of rows) {
    const bucket = byRule.get(row.rule);
    if (bucket === undefined) byRule.set(row.rule, [row]);
    else bucket.push(row);
  }
  const rules = [...byRule.keys()].sort();
  const sample: QuarantinedRow[] = [];
  for (let index = 0; sample.length < limit; index += 1) {
    let added = false;
    for (const rule of rules) {
      const row = byRule.get(rule)?.[index];
      if (row === undefined) continue;
      sample.push(row);
      added = true;
      if (sample.length >= limit) break;
    }
    if (!added) break;
  }
  return sample;
}
