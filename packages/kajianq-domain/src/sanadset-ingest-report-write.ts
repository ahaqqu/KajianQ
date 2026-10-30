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
import type { PilotReportDocument } from "./sanadset-ingest-report";

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
