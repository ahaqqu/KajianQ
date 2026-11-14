import type { SummarizerBenchRun } from "@app/contracts";
import {
  DECISION_GATE_FLOORS,
  accuracyByLanguage,
  evaluateDecisionGate,
  meanAccuracy,
  type GateOutcome,
} from "./decision-bench";
import { summarizerBenchRunSlug, type SummarizerBenchSeal } from "./summarizer-bench-store";
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
 * The summarizer-bench report renderer: the offline derivation of
 * `benchmarks/summarization/report.md` from the committed samples seal and
 * run files — never hand-edited, never networked. Every number is
 * recomputed from each run's per-case records; a run's own totals are never
 * trusted. Because the gate scores only what is deterministic (format
 * bounds, faithfulness grounding), every summary is printed verbatim —
 * theme quality stays the owner's human call, made from these artifacts.
 */

/** Records back to the minimal outcome the gate helpers read. */
function outcomesOf(records: readonly { language: string; passed: boolean }[]): GateOutcome[] {
  return records.map((r) => ({ language: r.language, passed: r.passed }));
}

function armCells(
  runsDir: string,
  run: SummarizerBenchRun,
  languages: readonly string[],
): string[] {
  const outcomes = outcomesOf(run.records);
  const gate = evaluateDecisionGate(outcomes);
  const perLanguage = accuracyByLanguage(outcomes);
  const p50 = p50LatencyMs(run.records);
  return [
    `\`${run.model}\``,
    `\`${runsDir}/${summarizerBenchRunSlug(run.model)}.json\``,
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
export function renderSummarizerBenchReport(opts: {
  seal: SummarizerBenchSeal;
  runs: readonly SummarizerBenchRun[];
  runsDir: string;
  generatedAt: string;
  supersededCount?: number;
}): string {
  const { seal, runs, runsDir, generatedAt } = opts;
  const languages = Object.keys(seal.languages).sort();
  const lines = benchReportHead({
    title: "Summarizer benchmark report",
    intro: `Generated offline from the committed samples (\`benchmarks/summarization/samples/\`) and run files (\`${runsDir}/\`) at ${generatedAt} — never hand-edited. Gate floors (ADR-0042's, applied per case): overall ≥ ${DECISION_GATE_FLOORS.overall} AND every language ≥ ${DECISION_GATE_FLOORS.perLanguage} (≥ ${DECISION_GATE_FLOORS.minCasesPerLanguage} scored cases per language); an arm that aborts is never a pass. The gate scores only what is deterministic — format bounds and faithfulness grounding; theme quality stays the owner's call, made from the summaries printed below.`,
    samples: [
      `- Seal **v${seal.version}** (created ${seal.created}): **${seal.counts.cases}** cases across ${languages.map((l) => `${l} (${seal.languages[l]})`).join(", ")}.`,
      `- Fixture \`${seal.fixture.id}\` (${seal.fixture.status}); cases pinned at \`${seal.hashes.cases}\`.`,
      ...(seal.notes ?? []).map((n) => `- ${n}`),
    ],
  });

  if (runs.length === 0) {
    lines.push(
      "No runs at the committed seal yet. Each keyed `eval:summarizer-bench` invocation appends one run file per candidate here; adding a model never re-runs the others.",
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
    const allClear =
      runs.length > 1 &&
      runs.every((run) => evaluateDecisionGate(outcomesOf(run.records)).gatePass);
    if (allClear) {
      lines.push(
        "Every arm clears the deterministic checks at this seal, so the gate did not separate them: no arm here is a quality winner, cost is the only measured difference, and the summaries below are the evidence for the owner's read.",
        "",
      );
    }
    lines.push("## Summaries (the evidence for the owner's read)", "");
    for (const run of runs) {
      lines.push(`### \`${run.model}\``);
      for (const r of run.records) {
        lines.push(
          `- \`${r.caseId}\` (${r.language}) — ${r.passed ? "pass" : "**fail**"}: "${r.got}"`,
        );
      }
      lines.push("");
    }
    lines.push(
      ...benchMissSection(
        runs.map((run) => ({
          model: run.model,
          details: run.records.filter((r) => !r.passed).map((m) => m.caseId),
        })),
        { compact: true },
      ),
    );
  }

  const passing = runs
    .filter((run) => evaluateDecisionGate(outcomesOf(run.records)).gatePass && run.aborted !== true)
    .map((run) => run.model);
  lines.push(
    ...benchSelectionSection(
      passing,
      "Adoption is a config change made by a reviewed PR; this report supplies evidence and never switches a serving row by itself.",
    ),
    ...benchSupersededSection(opts.supersededCount),
  );

  return lines.join("\n");
}
