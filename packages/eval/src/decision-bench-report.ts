import type { DecisionBenchRun } from "@app/contracts";
import {
  DECISION_GATE_FLOORS,
  accuracyByLanguage,
  evaluateDecisionGate,
  meanAccuracy,
  type GateOutcome,
} from "./decision-bench";
import { decisionBenchRunSlug, type DecisionBenchSeal } from "./decision-bench-store";
import {
  benchArmsTable,
  benchCostCell,
  benchGateCell,
  benchMissSection,
  benchReportHead,
  benchSelectionSection,
  benchSupersededSection,
  fmtPct,
  p50LatencyMs,
} from "./bench-report";

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

/** Records back to the minimal outcome the gate helpers read. */
function outcomesOf(records: readonly { language: string; passed: boolean }[]): GateOutcome[] {
  return records.map((r) => ({ language: r.language, passed: r.passed }));
}

function armCells(runsDir: string, run: DecisionBenchRun, languages: readonly string[]): string[] {
  const outcomes = outcomesOf(run.records);
  const gate = evaluateDecisionGate(outcomes);
  const perLanguage = accuracyByLanguage(outcomes);
  const p50 = p50LatencyMs(run.records);
  return [
    `\`${run.model}\``,
    `\`${runsDir}/${decisionBenchRunSlug(run.model)}.json\``,
    `${run.totals.scored}/${run.totals.cases}`,
    fmtPct(meanAccuracy(outcomes)),
    ...languages.map((l) => `${l} ${fmtPct(perLanguage[l]?.accuracy ?? null)}`),
    benchGateCell({
      pass: gate.gatePass,
      pinnedPass: run.gate.gatePass,
      aborted: run.aborted === true,
      error: run.error,
    }),
    benchCostCell(run.records, run.budget.totalMicroUsd),
    p50 === null ? "—" : `${p50} ms`,
    run.finishedAt,
  ];
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
  const lines = benchReportHead({
    title: "Decision benchmark report",
    intro: `Generated offline from the committed samples (\`benchmarks/decisions/samples/\`) and run files (\`${runsDir}/\`) at ${generatedAt} — never hand-edited. Gate floors (ADR-0042): overall ≥ ${DECISION_GATE_FLOORS.overall} AND every language ≥ ${DECISION_GATE_FLOORS.perLanguage} (≥ ${DECISION_GATE_FLOORS.minCasesPerLanguage} scored cases per language); an arm that aborts is never a pass.`,
    samples: [
      `- Seal **v${seal.version}** (created ${seal.created}): **${seal.counts.cases}** cases — ${seal.counts.relevance} relevance, ${seal.counts.rerank} rerank, ${seal.counts.citation} citation — across ${languages.map((l) => `${l} (${seal.languages[l]})`).join(", ")}.`,
      `- Fixture \`${seal.fixture.id}\` (${seal.fixture.status}); cases pinned at \`${seal.hashes.cases}\`.`,
      ...(seal.notes ?? []).map((n) => `- ${n}`),
    ],
  });

  if (runs.length === 0) {
    lines.push(
      "No runs at the committed seal yet. Each keyed `eval:decision-bench` invocation appends one run file per candidate here; adding a model never re-runs the others.",
      "",
    );
  } else {
    const languagesSeen = [
      ...new Set(runs.flatMap((r) => Object.keys(accuracyByLanguage(outcomesOf(r.records))))),
    ].sort();
    lines.push(
      ...benchArmsTable(
        [
          "Model",
          "Run file",
          "Scored",
          "Accuracy",
          ...languagesSeen,
          "Gate",
          "Cost",
          "p50 latency",
          "Finished",
        ],
        runs.map((run) => armCells(runsDir, run, languagesSeen)),
      ),
      "",
      "Accuracy, per-language accuracy and the gate verdict are recomputed from each run's records; the run's own totals are never trusted. Cost is the sum of per-case `costMicroUsd`; p50 latency covers the records that carry one. A run that aborts keeps its partial records and names the failure — it is evidence, never a gate result.",
      "",
    );
    lines.push(
      ...benchMissSection(
        runs.map((run) => ({
          model: run.model,
          details: run.records
            .filter((r) => !r.passed)
            .map(
              (m) =>
                `\`${m.task}/${m.caseId}\` (${m.language}): expected \`${String(m.expected)}\`, got \`${String(m.got)}\``,
            ),
        })),
      ),
    );
  }

  const passing = runs
    .filter((run) => evaluateDecisionGate(outcomesOf(run.records)).gatePass && run.aborted !== true)
    .map((run) => run.model);
  lines.push(
    ...benchSelectionSection(
      passing,
      "Adoption is a `benchAdoption` config change made by a reviewed PR; this report supplies evidence and never switches a serving row by itself.",
    ),
    ...benchSupersededSection(opts.supersededCount),
  );

  return lines.join("\n");
}
