/**
 * The human-readable report. It restates the JSON's measured facts rather than adding
 * any: every number here exists in `report.json`, and every limitation the JSON carries
 * is repeated, because the markdown is the artifact an owner actually reads before
 * deciding on the full run.
 *
 * Vocabulary is `CONTEXT.md`'s: a hadith's ordered narrators are an **isnad**, never a
 * "sanad" or a bare "chain", and the per-book matn groups are **children**. The dataset
 * name `Sanadset` and the source's own `<SANAD>` markup keep their spelling — they are
 * proper names, not the domain term.
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

/** A band bound rendered the way the threshold is registered (`0.60`, not `0.6`). */
function bound(value: number): string {
  return value.toFixed(2);
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

/** Why the arm stopped, in the report's own words rather than a bare enum. */
function describeStop(arm: StudyReportDocument["study"]["modelArm"]): string {
  if (arm.stopReason === "key-absent") return "the credential is absent, so the arm did not start";
  if (arm.stopReason === "not-requested") return "the run asked for no model calls";
  if (arm.stopReason === "ceiling-reached") return "the call ceiling stopped the arm";
  return "the arm ran inside the ceiling";
}

/** Render the markdown report; the JSON next to it is the machine-readable copy. */
export function renderReportMarkdown(document: StudyReportDocument): string {
  const facts = document.study;
  const arm = facts.modelArm;
  const lines: string[] = [];
  const band = `[${bound(facts.band.matnBandLower)}, ${bound(facts.band.matnBandUpper)})`;

  lines.push(`# Sanadset S1 — no-store-writes reconciliation study (${facts.runId})`, "");
  lines.push(
    "S1 reads the Sanadset archive, folds Arabic, blocks, and runs the matn cascade. It constructs no " +
      "database client, writes no store row, takes no snapshot and uploads nothing to object storage.",
    "",
  );
  lines.push("## Artifacts", "");
  lines.push(`- Directory: \`${facts.artifactsDir}\` (run-scoped; outside the checkout)`, "");
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
  lines.push(`- Rows with no isnad (skipped, not quarantined): ${count(facts.slice.noSanad)}`);
  lines.push(`- Quarantined by the row checks: ${count(facts.slice.quarantined)}`);
  lines.push(`- Prepared for the cascade: ${count(facts.slice.prepared)}`);
  lines.push(
    `- Isnad lists whose folded names repeat: ${count(facts.slice.repeatedNameChains)} — the archive concatenates parallel ` +
      "isnads into one `<SANAD>` list, so a repeated name is a shape of the source, not a self-loop; these rows are kept.",
  );
  lines.push(
    `- Rows whose \`<MATN>\`/\`<SANAD>\` open and close counts disagree: ${count(facts.slice.unbalancedTagRows)} — ` +
      "the tag structure, not a heuristic, is what makes those rows unparseable.",
  );
  lines.push("## Narrator coverage (deterministic pass)", "");
  lines.push(`- Mentions: ${count(facts.narrator.mentions)}`);
  lines.push(`- Distinct raw names: ${count(facts.narrator.rawDistinct)}`);
  lines.push(
    `- Distinct folded names: ${count(facts.narrator.foldedDistinct)} (${count(facts.narrator.foldedVariants)} raw spellings collapsed by the fold)`,
  );
  lines.push(
    `- Singleton names: ${count(facts.narrator.singletonClusters)} (${count(facts.narrator.singletonMentions)} mentions)`,
  );
  lines.push(
    `- Coverage rate (non-singleton mentions): ${percent(facts.narrator.nonSingletonMentionRate)} — a mention counts when its ` +
      "folded name occurs more than once, so this is a coalescing share, not an identity rate",
  );
  lines.push(
    `- Identity evidence, counted not adjudicated: ${count(facts.narrator.foldedVariants)} raw spellings the fold merged, ` +
      `${count(facts.narrator.bandNames)} names sharing a blocking key, ${count(facts.narrator.candidatePairs)} candidate pairs awaiting adjudication`,
  );
  lines.push(
    `- Blocking keys: ${count(facts.narrator.blockingKeys)}; ${count(facts.narrator.multiNameBlockingKeys)} of them hold two or more distinct names`,
    "",
  );
  lines.push("## Matn cascade", "");
  lines.push(`- Rows cascaded: ${count(facts.matn.preparedRows)}`);
  lines.push(
    `- Children after the cascade (book scope: **${facts.matn.bookScope}**): ${count(facts.matn.children)} — a child is a distinct matn inside one book, the thing an isnad attaches to`,
  );
  lines.push(
    `- Distinct normalized matns, book-agnostic: ${count(facts.matn.distinctMatnTexts)} — the pool the children are drawn from; ` +
      `the trigram stage merges different spellings, and a quarantined row becomes no child at all`,
  );
  lines.push(
    `- Cross-book joins: ${count(facts.matn.crossBook.joinsInThisRun)} in this run. ` +
      `Replaying the same cascade against an unscoped book joins ${count(facts.matn.crossBook.unscopedTotal)} rows across books ` +
      `(exact ${count(facts.matn.crossBook.unscopedExact)}, folded ${count(facts.matn.crossBook.unscopedFolded)}, ` +
      `trigram ${count(facts.matn.crossBook.unscopedTrigram)}) and yields ${count(facts.matn.crossBook.unscopedChildren)} children ` +
      `instead of ${count(facts.matn.crossBook.scopedChildren)}; with the ${count(facts.matn.matchRate.matchedRows)} in-book joins, ` +
      `${count(facts.matn.matchRate.matchedRows + facts.matn.crossBook.unscopedTotal)} deterministic joins`,
  );
  lines.push(
    `- Isnads per child (attachable rows / children): ${facts.matn.chainsPerChild.toFixed(4)}:1 — ` +
      `${count(facts.matn.attachableRows)} attachable rows over ${count(facts.matn.children)} children`,
  );
  lines.push(
    `- Isnads per child, quarantine-inclusive (${count(facts.matn.isnadBearingRows)} isnad-bearing rows / children): ` +
      `${facts.matn.chainsPerChildAllBearing.toFixed(4)}:1 — mixes two populations and is not the sizing input`,
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
  lines.push(
    `- Matn rows inside the band ${band}: ${count(facts.band.matnRows + facts.band.ambiguousQuarantined)} — ` +
      `${count(facts.band.matnRows)} needing one adjudication each + ` +
      `${count(facts.band.ambiguousQuarantined)} quarantined as an ambiguous best match ` +
      "(two groups within the margin), so never a call",
  );
  lines.push(
    `- Narrator candidate pairs needing identity adjudication: ${count(facts.band.narratorPairs)} over ${count(facts.band.narratorNames)} names`,
  );
  lines.push(
    `- Calls the work needs: sample ${count(facts.band.sampleCalls)} + band rows needing adjudication ` +
      `${count(facts.band.matnRows)} = ${count(facts.band.callsNeeded)}; ` +
      `the ceiling allows ${count(facts.band.callsBudgeted)} of ${count(facts.band.ceiling)}`,
    "",
  );
  lines.push("## Model arm", "");
  lines.push(`- Status: **${arm.stopReason}** (ran: ${String(arm.ran)}; ${describeStop(arm)})`);
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
      `- Pre-flight projection (band + pre-registered sample): ${count(arm.estimate.calls)} calls · ${count(arm.estimate.tokensIn)} in / ${count(arm.estimate.tokensOut)} out · ${usd(arm.estimate.costMicroUsd)} (estimated, not metered)`,
    );
  }
  lines.push("");
  lines.push("## Blind sample (pre-registered before any model output)", "");
  lines.push(
    `- Seed: ${facts.sample.seed} · requested ${count(facts.sample.requested)} · selected ${count(facts.sample.selected)} · shortfall ${count(facts.sample.shortfall)}`,
  );
  lines.push(
    "- A pair whose two sides are identical strings is never drawn: it is a free answer, not a question",
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
