/**
 * The pilot's report: the `IngestionReport` contract plus the facts the §9.4 report
 * owes — match rate with its scope, narrator coverage with its basis, quarantine by
 * rule, and a cost of exactly zero (this path makes no model call).
 *
 * It is written outside the checkout, like the study's artifacts: it carries corpus
 * text and is evidence, not a source file. A dry run writes it too, so the plan the
 * operator reads and the run that follows cannot drift apart.
 */

import type { IngestionReport } from "@app/contracts";
import { dirname, join, basename } from "node:path";
import {
  DEFAULT_ARTIFACT_DIR,
  assertOutsideRepository,
  jsonFile,
  writeArtifactFiles,
} from "./sanadset-artifacts";
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

/** The default report path: the per-user cache, run-scoped, outside the checkout. */
export function defaultPilotReportPath(homeDir: string, runId: string): string {
  return join(homeDir, DEFAULT_ARTIFACT_DIR, runId, "report.json");
}

/** Refuse an explicit `--report` path inside a checkout before the run starts writing. */
export function assertPilotReportPath(path: string): void {
  assertOutsideRepository(dirname(path));
}

/**
 * Write the JSON report and its Markdown digest beside it. `writeArtifactFiles`
 * repeats the outside-the-checkout refusal, so a `--report` path cannot land in a
 * working tree.
 */
export function writePilotReport(document: PilotReportDocument, path: string): readonly string[] {
  const markdownName = basename(path).endsWith(".json")
    ? `${basename(path, ".json")}.md`
    : `${basename(path)}.md`;
  return writeArtifactFiles(dirname(path), [
    { name: basename(path), content: jsonFile(document) },
    { name: markdownName, content: renderPilotMarkdown(document) },
  ]);
}

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;

/** A human digest of the same document: what the operator reads before a real run. */
export function renderPilotMarkdown(document: PilotReportDocument): string {
  const { pilot } = document;
  const rules = Object.entries(pilot.slice.quarantinedByRule)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rule, count]) => `  - \`${rule}\`: ${count}`);
  return [
    `# Sanadset S2 pilot — ${pilot.collection} (${pilot.runId})`,
    "",
    pilot.dryRun
      ? "**Dry run: the plan only; no row was written.**"
      : "**Store-writing run: the counts below are what was written.**",
    "",
    "## Command",
    "",
    "```",
    pilot.command,
    "```",
    "",
    "## Source",
    "",
    `- File: \`${pilot.source.fileName}\` (${pilot.source.bytes} bytes)`,
    `- SHA-256: \`${pilot.source.sha256}\``,
    `- Records read: ${pilot.source.recordsRead}`,
    "",
    "## Snapshot gate",
    "",
    `- Mode: **${pilot.gate.mode}**${pilot.gate.label === null ? "" : ` (label \`${pilot.gate.label}\`)`}`,
    ...pilot.gate.reasons.filter((reason) => reason.trim() !== "").map((reason) => `- ${reason}`),
    "",
    "## Slice",
    "",
    `- Book: \`${pilot.book}\``,
    `- Rows in slice: ${pilot.slice.rows}`,
    `- No-sanad rows (skipped): ${pilot.slice.noSanad}`,
    `- Prepared: ${pilot.slice.prepared}`,
    `- Quarantined: ${pilot.slice.quarantined}`,
    ...(rules.length === 0 ? [] : ["", "By rule:", ...rules]),
    "",
    "## Narrator resolution (deterministic, name-level)",
    "",
    `- Identity basis: \`${pilot.narrator.identityBasis}\` — a folded name is a cluster, not a person`,
    `- Mentions: ${pilot.narrator.mentions}`,
    `- Folded names: ${pilot.narrator.foldedNames} (from ${pilot.narrator.rawSurfaces} raw surfaces)`,
    `- Recorded variants: ${pilot.narrator.variantsRecorded}`,
    `- Coverage (non-singleton mentions): ${percent(pilot.narrator.coverageRate)}`,
    `- Narrator rows written: ${pilot.narrator.written}`,
    `- Uncertain name pairs reported, not merged: ${pilot.narrator.uncertainPairs}`,
    "",
    "## Matn reconciliation (book-scoped)",
    "",
    `- Matn groups: ${pilot.matn.groups}`,
    `- Stored children compared: ${pilot.matn.storedChildrenCompared}`,
    `- Groups matched to a stored child: ${pilot.matn.matchedGroups}`,
    `- Groups quarantined as ambiguous: ${pilot.matn.ambiguousGroups}`,
    `- Groups written as new children: ${pilot.matn.newChildren}`,
    `- Children created: ${pilot.matn.createdChildren}`,
    `- Match rate (scope **${pilot.matn.matchRate.scope}**): ${percent(pilot.matn.matchRate.value)} (${pilot.matn.matchRate.matchedRows} of ${pilot.matn.matchRate.rows} rows)`,
    `- Trigram searches that hit the candidate cap: ${pilot.matn.truncatedSearches}`,
    "",
    "## Chains",
    `- Chains planned: ${pilot.chains.planned}`,
    `- Chains written: ${pilot.chains.written}`,
    `- Model calls: ${pilot.cost.modelCalls} · cost: $${(pilot.cost.costMicroUsd / 1_000_000).toFixed(4)}`,
    "",
    "## Limits",
    "",
    ...pilot.limits.map((limit) => `- ${limit}`),
    "",
    `_Wall clock: ${pilot.timings.finishedAt - pilot.timings.startedAt} ms._`,
    "",
  ].join("\n");
}
