/**
 * Where the pilot's report lands and how it is written.
 *
 * Split from the report builder so the builder stays content and this module stays
 * I/O: the path is defaulted under the per-user cache and every write goes through
 * the study's artifact writer, which refuses a directory inside any working tree of
 * this repository. The report carries corpus text and is evidence, not a source file.
 */

import { basename, dirname, join } from "node:path";
import {
  DEFAULT_ARTIFACT_DIR,
  assertOutsideRepository,
  jsonFile,
  writeArtifactFiles,
} from "./sanadset-artifacts";
import type { PlanArtifact } from "./sanadset-ingest-plan-artifact";
import type { PilotReportDocument } from "./sanadset-ingest-report";
import type { WriteCounts } from "./sanadset-ingest-reconcile";

/** The default report path: the per-user cache, run-scoped, outside the checkout. */
export function defaultPilotReportPath(homeDir: string, runId: string): string {
  return join(homeDir, DEFAULT_ARTIFACT_DIR, runId, "report.json");
}

/** The plan artifact lands beside the report by default; `--plan-out` overrides the path. */
export function defaultPilotPlanPath(reportPath: string): string {
  return join(dirname(reportPath), "plan.json");
}

/** Refuse an explicit `--report` path inside a checkout before the run starts writing. */
export function assertPilotReportPath(path: string): void {
  assertOutsideRepository(dirname(path));
}

/** The same refusal for `--plan-out`: the plan carries corpus text too. */
export function assertPilotPlanPath(path: string): void {
  assertOutsideRepository(dirname(path));
}

/**
 * Write the plan artifact (JSON only). `writeArtifactFiles` repeats the
 * outside-the-checkout refusal, so a `--plan-out` path cannot land in a working tree.
 */
export function writePilotPlan(artifact: PlanArtifact, path: string): readonly string[] {
  return writeArtifactFiles(dirname(path), [{ name: basename(path), content: jsonFile(artifact) }]);
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

/** One row set's counts, labelled so a rerun cannot read as a first run. */
function countsLine(label: string, counts: WriteCounts): string {
  return (
    `- ${label}: ${counts.created} created · ${counts.updated} updated · ` +
    `${counts.unchanged} unchanged · ${counts.deleted} deleted`
  );
}

/** A human digest of the same document: what the operator reads before a real run. */
export function renderPilotMarkdown(document: PilotReportDocument): string {
  const { pilot } = document;
  const rules = Object.entries(pilot.quarantine.byRule)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rule, count]) => `  - \`${rule}\`: ${count}`);
  const afterSlice = pilot.quarantine.total - pilot.slice.quarantined;
  const planLines = pilot.plan.sample.map((group) => {
    const target = group.target;
    if (target.kind === "existing") {
      return `- Group ${group.groupId} (row ${group.representativeRowIndex}, hadith ${group.hadithNumber}) → stored child \`${target.childId}\` — score ${target.score?.toFixed(3)} by ${target.how}${target.childTextSha256 === undefined ? "" : `, text \`${target.childTextSha256.slice(0, 12)}\``}`;
    }
    if (target.kind === "fragmentary") {
      return `- Group ${group.groupId} (row ${group.representativeRowIndex}) → **quarantined**: best candidate \`${target.childId}\` scored ${target.score?.toFixed(3)} by ${target.how}, but ${target.reason}`;
    }
    if (target.kind === "ambiguous") {
      return `- Group ${group.groupId} (row ${group.representativeRowIndex}) → **quarantined**: ${target.score?.toFixed(3)} against ${target.candidates?.join(", ")}`;
    }
    if (target.kind === "truncated") {
      return `- Group ${group.groupId} (row ${group.representativeRowIndex}) → **quarantined**: candidate search hit its ${target.cap}-candidate cap`;
    }
    return `- Group ${group.groupId} (row ${group.representativeRowIndex}) → new child`;
  });
  const quarantineLines = pilot.plan.quarantineSample.map(
    (row) => `- Row ${row.rowIndex} (hadith ${row.hadithNumber}) \`${row.rule}\`: ${row.detail}`,
  );
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
    `- Quarantine total: ${pilot.quarantine.total}`,
    `- Quarantined before the matn cascade: ${pilot.slice.quarantined}`,
    `- Held back after the cascade or by a refused target: ${afterSlice}`,
    ...(rules.length === 0 ? [] : ["", "By rule:", ...rules]),
    "",
    "## Narrator resolution (deterministic name clusters)",
    "",
    `- Identity basis: \`${pilot.narrator.identityBasis}\` — a folded name is a Name cluster, not a resolved Narrator`,
    `- Mentions: ${pilot.narrator.mentions}`,
    `- Folded names: ${pilot.narrator.foldedNames} (from ${pilot.narrator.rawSurfaces} raw surfaces)`,
    `- Recorded variants: ${pilot.narrator.variantsRecorded}`,
    `- Name-level resolution rate (non-singleton mentions): ${percent(pilot.narrator.resolutionRate)}`,
    `- Name-cluster rows upserted: ${pilot.narrator.upserted}`,
    `- Uncertain name pairs reported, not merged: ${pilot.narrator.uncertainPairs}`,
    "",
    "## Matn reconciliation (book-scoped)",
    "",
    `- Matn groups: ${pilot.matn.groups}`,
    `- Stored children compared: ${pilot.matn.storedChildrenCompared}`,
    `- Groups matched to a stored child: ${pilot.matn.matchedGroups}`,
    `- Groups quarantined as ambiguous: ${pilot.matn.ambiguousGroups}`,
    `- Groups quarantined as fragments of a longer narration: ${pilot.matn.fragmentaryGroups}`,
    `- Groups written as new children: ${pilot.matn.newChildren}`,
    `- Match rate (scope **${pilot.matn.matchRate.scope}**): ${percent(pilot.matn.matchRate.value)} (${pilot.matn.matchRate.matchedRows} of ${pilot.matn.matchRate.rows} rows with a claimed target; ${pilot.matn.matchRate.refusedRows} refused a target)`,
    `- Candidate searches that hit their cap: ${pilot.matn.truncatedSearches}`,
    "",
    "## Plan sample",
    "",
    pilot.plan.artifactPath === null
      ? "- Plan artifact: not written."
      : `- Plan artifact: \`${pilot.plan.artifactPath}\` (every group and every quarantine row)`,
    `- Targets by kind: ${Object.entries(pilot.plan.byTarget)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, count]) => `${kind} ${count}`)
      .join(" · ")}`,
    "",
    ...planLines,
    "",
    `## Quarantine sample (${pilot.plan.quarantineSample.length} of ${pilot.quarantine.total})`,
    "",
    ...quarantineLines,
    "",
    "## Write outcome",
    "",
    ...(pilot.dryRun
      ? [
          `- Dry run: nothing written; the plan would create ${pilot.matn.newChildren} children and write ${pilot.chains.planned} chains.`,
        ]
      : [countsLine("Children", pilot.write.children), countsLine("Chains", pilot.write.chains)]),
    "",
    "## Chains",
    `- Chains planned: ${pilot.chains.planned}`,
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
