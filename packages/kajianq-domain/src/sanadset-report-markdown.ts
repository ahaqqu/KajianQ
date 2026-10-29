/**
 * The human-readable report. It restates the JSON's measured facts rather than adding
 * any: every number here exists in `report.json`, and every limitation the JSON carries
 * is repeated, because the markdown is the artifact an owner actually reads before
 * deciding on the full run.
 */

import type { StudyFacts, StudyReportDocument } from "./sanadset-report-types";

const PERCENT = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 });
const COUNT = new Intl.NumberFormat("en-US");
const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

function percent(value: number): string {
  return PERCENT.format(value);
}

function count(value: number): string {
  return COUNT.format(value);
}

function usd(microUsd: number): string {
  return USD.format(microUsd / 1_000_000);
}

function gateRows(facts: StudyFacts): string[] {
  const rows = [
    "| Gate | Threshold | Measured | Status | Why |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const gate of facts.gates) {
    rows.push(
      `| ${gate.id} | ${gate.threshold} | ${gate.measured ?? "—"} | **${gate.status}** | ${gate.reason} |`,
    );
  }
  return rows;
}

function quarantineRows(facts: StudyFacts): string[] {
  const rules = Object.entries(facts.quarantine.byRule).sort((left, right) => right[1] - left[1]);
  if (rules.length === 0) return ["No row was quarantined."];
  const rows = ["| Rule | Rows |", "| --- | --- |"];
  for (const [rule, value] of rules) rows.push(`| \`${rule}\` | ${count(value)} |`);
  return rows;
}

function stratumRows(facts: StudyFacts): string[] {
  const rows = ["| Stratum | Target | Candidates | Selected |", "| --- | --- | --- | --- |"];
  for (const stratum of facts.sample.composition) {
    rows.push(
      `| \`${stratum.stratum}\` | ${count(stratum.target)} | ${count(stratum.candidates)} | ${count(stratum.selected)} |`,
    );
  }
  return rows;
}

/** Render the markdown report; the JSON next to it is the machine-readable copy. */
export function renderReportMarkdown(document: StudyReportDocument): string {
  const facts = document.study;
  const arm = facts.modelArm;
  const lines: string[] = [];

  lines.push(`# Sanadset S1 — no-store-writes reconciliation study (${facts.runId})`, "");
  lines.push(
    "S1 reads the Sanadset archive, folds Arabic, blocks, and runs the matn cascade. It constructs no " +
      "database client, writes no store row, takes no snapshot and uploads nothing to object storage.",
    "",
  );
  lines.push("## Command", "", "```", facts.command, "```", "");
  lines.push("## Source", "");
  lines.push(`- File: \`${facts.source.fileName}\` (${count(facts.source.bytes)} bytes)`);
  lines.push(`- SHA-256: \`${facts.source.sha256}\``);
  lines.push(`- Records read: ${count(facts.source.recordsRead)}`, "");
  lines.push("## Slice", "");
  lines.push(
    `- Books: ${facts.slice.books.map((book) => `\`${book}\``).join(", ")} (exact match, not substring)`,
  );
  lines.push(`- Rows in slice: ${count(facts.slice.rows)}`);
  lines.push(`- No-sanad rows (skipped, not quarantined): ${count(facts.slice.noSanad)}`);
  lines.push(`- Quarantined: ${count(facts.slice.quarantined)}`);
  lines.push(`- Prepared for the cascade: ${count(facts.slice.prepared)}`);
  lines.push(
    `- Chains whose folded names repeat: ${count(facts.slice.repeatedNameChains)} — the archive concatenates parallel ` +
      "isnads into one `Sanad` list, so a repeated name is a shape of the source, not a self-loop; these rows are kept.",
  );
  lines.push(
    `- Rows whose \`<MATN>\`/\`<SANAD>\` open and close counts disagree: ${count(facts.slice.unbalancedTagRows)} — ` +
      "the tag structure, not a heuristic, is what makes those rows unparseable.",
  );
  lines.push("## Narrator resolution (deterministic pass)", "");
  lines.push(`- Mentions: ${count(facts.narrator.mentions)}`);
  lines.push(`- Distinct raw names: ${count(facts.narrator.rawDistinct)}`);
  lines.push(
    `- Distinct folded names: ${count(facts.narrator.foldedDistinct)} (${count(facts.narrator.foldedVariants)} raw spellings collapsed by the fold)`,
  );
  lines.push(
    `- Singleton names: ${count(facts.narrator.singletonClusters)} (${count(facts.narrator.singletonMentions)} mentions)`,
  );
  lines.push(
    `- Resolution rate: ${percent(facts.narrator.resolutionRate)} — a singleton is not counted as resolved`,
  );
  lines.push(
    `- Blocking keys: ${count(facts.narrator.blockingKeys)}; ${count(facts.narrator.multiNameBlockingKeys)} of them hold two or more distinct names`,
  );
  lines.push(
    `- Candidate identity pairs in the narrator band: ${count(facts.narrator.candidatePairs)}`,
    "",
  );
  lines.push("## Matn cascade", "");
  lines.push(`- Rows cascaded: ${count(facts.matn.preparedRows)}`);
  lines.push(`- Distinct matns after the cascade: ${count(facts.matn.groups)}`);
  lines.push(
    `- Chains per child (chain-bearing rows / distinct prepared matns): ${facts.matn.chainsPerChild.toFixed(4)}:1`,
  );
  lines.push(
    `- Match rate (scope **${facts.matn.matchRate.scope}**): ${percent(facts.matn.matchRate.value)} ` +
      `(${count(facts.matn.matchRate.matchedRows)} of ${count(facts.matn.matchRate.rows)} rows)`,
  );
  for (const [kind, value] of Object.entries(facts.matn.byKind))
    lines.push(`  - \`${kind}\`: ${count(value)}`);
  lines.push(
    `- Candidate cap hits (bounded recall, never a forced match): ${count(facts.matn.candidateCapHits)}`,
    "",
  );
  lines.push("## Model band", "");
  lines.push(`- Matn rows inside the band [0.60, 0.90): ${count(facts.band.matnRows)}`);
  lines.push(
    `- Narrator candidate pairs needing identity adjudication: ${count(facts.band.narratorPairs)} over ${count(facts.band.narratorNames)} names`,
  );
  lines.push(
    `- Calls the work needs: ${count(facts.band.callsNeeded)}; calls the ceiling allows: ${count(facts.band.callsBudgeted)} of ${count(facts.band.ceiling)}`,
    "",
  );
  lines.push("## Model arm", "");
  lines.push(
    `- Status: **${arm.stopReason}** (ran: ${String(arm.ran)}; key ${arm.keyPresent ? `present via ${arm.keySource}` : "absent"})`,
  );
  lines.push(
    `- Provider: \`${arm.provider}\` · endpoint \`${arm.baseUrl}\` · model \`${arm.model}\``,
  );
  lines.push(
    `- Price on file: $${arm.price.inputUsdPerMTok}/MTok in, $${arm.price.outputUsdPerMTok}/MTok out`,
  );
  lines.push(
    `- Calls: ${count(arm.calls)} · requests: ${count(arm.requests)} · tokens in/out: ${count(arm.tokensIn)}/${count(arm.tokensOut)}${arm.estimatedTokens ? " (estimated)" : " (metered)"}`,
  );
  lines.push(`- Spend: ${usd(arm.spendMicroUsd)}`);
  if (arm.estimate !== null) {
    lines.push(
      `- Pre-flight projection for the band: ${count(arm.estimate.calls)} calls · ${count(arm.estimate.tokensIn)} in / ${count(arm.estimate.tokensOut)} out · ${usd(arm.estimate.costMicroUsd)} (estimated, not metered)`,
    );
  }
  lines.push("");
  lines.push("## Blind sample (pre-registered before any model output)", "");
  lines.push(
    `- Seed: ${facts.sample.seed} · requested ${count(facts.sample.requested)} · selected ${count(facts.sample.selected)} · shortfall ${count(facts.sample.shortfall)}`,
  );
  lines.push("- Labels present in this artifact set: no (the template ships empty)", "");
  lines.push(...stratumRows(facts), "");
  lines.push("## Quarantine", "");
  lines.push(`Total quarantined: ${count(facts.quarantine.total)}`, "");
  lines.push(...quarantineRows(facts), "");
  lines.push("## Go/no-go gates", "");
  lines.push(...gateRows(facts), "");
  lines.push("## Limitations", "");
  for (const limit of facts.limits) lines.push(`- ${limit}`);
  lines.push("");
  return lines.join("\n");
}
