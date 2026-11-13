import type { DecisionBenchRun, DecisionBenchRunRecord } from "@app/contracts";
import {
  DECISION_GATE_FLOORS,
  accuracyByLanguage,
  evaluateDecisionGate,
  meanAccuracy,
} from "./decision-bench";
import { decisionBenchRunSlug, type DecisionBenchSeal } from "./decision-bench-store";

/**
 * The decision-bench report renderer (ADR-0042): the offline derivation of
 * `benchmarks/decisions/report.md` from the committed samples seal and run
 * files — never hand-edited, never networked. Every number is recomputed
 * from each run's per-case records; a run's own totals are never trusted.
 * Selection is the gate, stated mechanically: an arm passes when overall
 * accuracy and every scored language clear the floors — and the report
 * never switches a serving row itself; adoption is a `benchAdoption` config
 * change made by a reviewed PR.
 */

/** Records back to the outcome shape the metric helpers consume. */
function asOutcomes(records: readonly DecisionBenchRunRecord[]) {
  return records.map((r) => ({
    caseId: r.caseId,
    task: r.task,
    language: r.language,
    expected: r.expected,
    got: r.got,
    passed: r.passed,
  }));
}

/** p50 of the per-record latencies that exist (a record without cost leaves the sample). */
function p50LatencyMs(records: readonly DecisionBenchRunRecord[]): number | null {
  const xs = records
    .map((r) => r.cost?.latencyMs)
    .filter((x): x is number => typeof x === "number")
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  return xs[Math.floor((xs.length - 1) / 2)]!;
}

function fmtPct(x: number | null): string {
  return x === null ? "—" : `${(x * 100).toFixed(1)}%`;
}

function fmtCost(run: DecisionBenchRun): string {
  const perCase = run.records.map((r) => r.cost?.costMicroUsd ?? 0).reduce((a, b) => a + b, 0);
  return `${perCase} µUSD total${run.budget.totalMicroUsd !== perCase ? ` (budget bookkeeping ${run.budget.totalMicroUsd})` : ""}`;
}

function armRow(runsDir: string, run: DecisionBenchRun): string {
  const outcomes = asOutcomes(run.records);
  const gate = evaluateDecisionGate(outcomes);
  const perLanguage = accuracyByLanguage(outcomes);
  const languages = Object.keys(perLanguage).sort();
  const disagree = gate.gatePass !== run.gate.gatePass ? " (pinned gate disagrees)" : "";
  const aborted = run.aborted === true ? ` ⚠ aborted (${run.error ?? "unnamed failure"})` : "";
  const p50 = p50LatencyMs(run.records);
  const cells = [
    `\`${run.model}\``,
    `\`${runsDir}/${decisionBenchRunSlug(run.model)}.json\``,
    `${run.totals.scored}/${run.totals.cases}`,
    fmtPct(meanAccuracy(outcomes)),
    ...languages.map((l) => `${l} ${fmtPct(perLanguage[l]?.accuracy ?? null)}`),
    `**${gate.gatePass ? "pass" : "fail"}**${disagree}${aborted}`,
    fmtCost(run),
    p50 === null ? "—" : `${p50} ms`,
    run.finishedAt,
  ];
  return `| ${cells.join(" | ")} |`;
}

/** The markdown report body — written to `report.md`, never edited by hand. */
export function renderDecisionBenchReport(opts: {
  seal: DecisionBenchSeal;
  runs: readonly DecisionBenchRun[];
  runsDir: string;
  generatedAt: string;
  supersededCount?: number;
}): string {
  const { seal, runs, runsDir, generatedAt } = opts;
  const languages = Object.keys(seal.languages).sort();
  const lines: string[] = [
    "# Decision benchmark report",
    "",
    `Generated offline from the committed samples (\`benchmarks/decisions/samples/\`) and run files (\`${runsDir}/\`) at ${generatedAt} — never hand-edited. Gate floors (ADR-0042): overall ≥ ${DECISION_GATE_FLOORS.overall} AND every language ≥ ${DECISION_GATE_FLOORS.perLanguage} (≥ ${DECISION_GATE_FLOORS.minCasesPerLanguage} scored cases per language); an arm that aborts is never a pass.`,
    "",
    "## Samples",
    "",
    `- Seal **v${seal.version}** (created ${seal.created}): **${seal.counts.cases}** cases — ${seal.counts.relevance} relevance, ${seal.counts.rerank} rerank, ${seal.counts.citation} citation — across ${languages.map((l) => `${l} (${seal.languages[l]})`).join(", ")}.`,
    `- Fixture \`${seal.fixture.id}\` (${seal.fixture.status}); cases pinned at \`${seal.hashes.cases}\`.`,
    ...(seal.notes ?? []).map((n) => `- ${n}`),
    "",
    "## Arms",
    "",
  ];

  if (runs.length === 0) {
    lines.push(
      "No runs at the committed seal yet. Each keyed `eval:decision-bench` invocation appends one run file per candidate here; adding a model never re-runs the others.",
      "",
    );
  } else {
    const languagesSeen = [
      ...new Set(runs.flatMap((r) => Object.keys(accuracyByLanguage(asOutcomes(r.records))))),
    ].sort();
    lines.push(
      `| Model | Run file | Scored | Accuracy | ${languagesSeen.join(" | ")} | Gate | Cost | p50 latency | Finished |`,
      `| --- | --- | --- | --- | ${languagesSeen.map(() => "---").join(" | ")} | --- | --- | --- | --- |`,
      ...runs.map((run) => armRow(runsDir, run)),
      "",
      "Accuracy, per-language accuracy and the gate verdict are recomputed from each run's records; the run's own totals are never trusted. Cost is the sum of per-case `costMicroUsd`; p50 latency covers the records that carry one. A run that aborts keeps its partial records and names the failure — it is evidence, never a gate result.",
      "",
      "## Misses",
      "",
    );
    const missLines = runs.flatMap((run) => {
      const misses = run.records.filter((r) => !r.passed);
      if (misses.length === 0) return [`- \`${run.model}\`: none.`];
      return [
        `- \`${run.model}\` (${misses.length}):`,
        ...misses.map(
          (m) =>
            `  - \`${m.task}/${m.caseId}\` (${m.language}): expected \`${String(m.expected)}\`, got \`${String(m.got)}\``,
        ),
      ];
    });
    lines.push(...missLines, "");
  }

  const passing = runs.filter((run) => {
    const gate = evaluateDecisionGate(asOutcomes(run.records));
    return gate.gatePass && run.aborted !== true;
  });
  lines.push(
    "## Selection",
    "",
    passing.length === 0
      ? "No arm passes the gate at this seal."
      : `Gate-passing arms at this seal: ${passing.map((r) => `\`${r.model}\``).join(", ")}.`,
    "",
    "Adoption is a `benchAdoption` config change made by a reviewed PR; this report supplies evidence and never switches a serving row by itself.",
    "",
  );

  if ((opts.supersededCount ?? 0) > 0) {
    lines.push(
      "## Superseded",
      "",
      `${opts.supersededCount} frozen result(s) under \`superseded/\` predate the committed seal or an earlier one — kept as history, never scored.`,
      "",
    );
  }

  return lines.join("\n");
}
