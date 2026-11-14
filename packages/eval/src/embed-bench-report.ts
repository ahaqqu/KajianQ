import type { EmbedBenchRun } from "@app/contracts";
import {
  EMBED_BENCH_DIRECTIONS,
  embedDirectionStats,
  embedExpansionAccuracy,
  type EmbedDirectionStats,
} from "@app/contracts";
import { GATE_FLOORS, evaluateGate, type BenchCell, type BenchDirection } from "./embed-bench";
import { embedBenchRunSlug, type EmbedBenchSeal } from "./embed-bench-store";
import {
  benchArmsTable,
  benchGateCell,
  benchMissSection,
  benchReportHead,
  benchSelectionSection,
  benchSupersededSection,
  fmtPct,
} from "./bench-report";

/**
 * The embed-bench report renderer (issue #9, ADR-0013/0014): the offline
 * derivation of `benchmarks/embeddings/report.md` from the committed samples
 * seal and run files — never hand-edited, never networked. Every number is
 * recomputed from each run's per-probe records; a run's own totals are never
 * trusted. Selection is the gate, stated mechanically: an arm passes when
 * both gate directions clear their recall@10 floors — and the report never
 * switches the `embedder` role itself; adoption is a config change made by a
 * reviewed PR.
 */

/** A run's gate verdict, recomputed through the gate itself (no drift with the scorer). */
function gateOf(stats: Record<string, EmbedDirectionStats>): { gatePass: boolean } {
  const cellOf = (direction: BenchDirection): BenchCell => {
    const s = stats[direction];
    return {
      direction,
      queries: s?.probes ?? 0,
      recallAtK: s?.recallAt10 ?? null,
      mrr: s?.mrr ?? null,
      probeOutcomes: [],
    };
  };
  return evaluateGate({ cells: [cellOf("secondary→primary"), cellOf("primary→primary")] });
}

function fmtMrr(x: number | null): string {
  return x === null ? "—" : x.toFixed(3);
}

/** One direction's cell: recall@10 with MRR, or the expansion pass rate. */
function directionCell(
  run: EmbedBenchRun,
  direction: string,
  stats: Record<string, EmbedDirectionStats>,
): string {
  if (direction === "expansion") return fmtPct(embedExpansionAccuracy(run.records));
  const s = stats[direction];
  if (!s || s.recallAt10 === null) return "—";
  return `${fmtPct(s.recallAt10)} (${fmtMrr(s.mrr)})`;
}

function armCells(runsDir: string, run: EmbedBenchRun, columns: readonly string[]): string[] {
  const stats = embedDirectionStats(run.records);
  const gate = gateOf(stats);
  return [
    `\`${run.model}\``,
    `\`${runsDir}/${embedBenchRunSlug(run.model)}.json\``,
    ...columns.map((d) => directionCell(run, d, stats)),
    benchGateCell({
      pass: gate.gatePass,
      pinnedPass: run.gate.gatePass,
      aborted: run.aborted === true,
      error: run.error,
    }),
    `${run.budget.totalMicroUsd} µUSD`,
    run.finishedAt,
  ];
}

/** The markdown report body — written to `report.md`, never edited by hand. */
export function renderEmbedBenchReport(opts: {
  seal: EmbedBenchSeal;
  runs: readonly EmbedBenchRun[];
  runsDir: string;
  generatedAt: string;
  supersededCount?: number;
}): string {
  const { seal, runs, runsDir, generatedAt } = opts;
  const lines = benchReportHead({
    title: "Embedding benchmark report",
    intro: `Generated offline from the committed samples (\`benchmarks/embeddings/samples/\`) and run files (\`${runsDir}/\`) at ${generatedAt} — never hand-edited. Gate floors (ADR-0013): cross-lingual \`secondary→primary\` recall@10 ≥ ${GATE_FLOORS.crossLingual} AND monolingual \`primary→primary\` recall@10 ≥ ${GATE_FLOORS.monolingual}; an arm that aborts is never a pass.`,
    samples: [
      `- Seal **v${seal.version}** (created ${seal.created}): **${seal.counts.crossLingual + seal.counts.monolingual}** retrieval probes — ${seal.counts.crossLingual} cross-lingual, ${seal.counts.monolingual} monolingual — plus **${seal.counts.expansion}** expansion cases.`,
      `- Fixtures \`${seal.fixtures.probes.id}\` (${seal.fixtures.probes.status}) + \`${seal.fixtures.expansion.id}\` (${seal.fixtures.expansion.status}); probes pinned at \`${seal.hashes.probes}\`, expansion at \`${seal.hashes.expansion}\`; corpus fingerprint \`${seal.fingerprints.corpus}\`.`,
      ...(seal.notes ?? []).map((n) => `- ${n}`),
    ],
  });

  if (runs.length === 0) {
    lines.push(
      "No runs at the committed seal yet. Each keyed `eval:embed-bench` invocation appends one run file per candidate here; adding a model never re-runs the others.",
      "",
    );
  } else {
    const order = new Map<string, number>(EMBED_BENCH_DIRECTIONS.map((d, i) => [d, i] as const));
    const seen = [...new Set(runs.flatMap((r) => r.records.map((rec) => rec.direction)))].sort(
      (a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity),
    );
    lines.push(
      ...benchArmsTable(
        ["Model", "Run file", ...seen, "Gate", "Cost", "Finished"],
        runs.map((run) => armCells(runsDir, run, seen)),
      ),
      "",
      "Direction cells show recall@10 with MRR in parentheses, recomputed from each run's records; the run's own totals are never trusted. The expansion cell is the mean pass rate over the run's expansion records. Cost is the run's budget bookkeeping (its total metered spend); per-call cost records cover the expansion calls. A run that aborts keeps its partial records and names the failure — it is evidence, never a gate result.",
      "",
    );
    lines.push(
      ...benchMissSection(
        runs.map((run) => ({
          model: run.model,
          details: run.records
            .filter((r) => !r.passed)
            .map((m) => {
              const expected = Array.isArray(m.expected) ? m.expected.join(", ") : m.expected;
              return `\`${m.direction}/${m.probeId}\`: expected \`${expected}\`, got \`${m.got.join(", ")}\``;
            }),
        })),
      ),
    );
  }

  const passing = runs
    .filter((run) => gateOf(embedDirectionStats(run.records)).gatePass && run.aborted !== true)
    .map((run) => run.model);
  lines.push(
    ...benchSelectionSection(
      passing,
      "Adoption is an `embedder` role change made by a reviewed PR; this report supplies evidence and never switches a serving row by itself.",
    ),
    ...benchSupersededSection(opts.supersededCount),
  );

  return lines.join("\n");
}
