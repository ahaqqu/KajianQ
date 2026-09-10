#!/usr/bin/env bun
/**
 * embed-bench.mjs — the embedding-benchmark CLI (issue #9, ADR-0013/0014
 * go/no-go gate for the retrieval posture).
 *
 *   bun run eval:embed-bench
 *
 * Env (validated by loadEmbedBenchConfig before any spend):
 *   NEON_DATABASE_URL     required (validated shape; the run itself is
 *                         source-based and DB-free)
 *   GEMINI_API_KEY        the vendor key every candidate needs (absent =
 *                         fail fast, never silently skip a candidate)
 *   EVAL_BUDGET_MICRO_USD optional hard spend cap in micro-USD
 *   BENCH_SURAHS / BENCH_HADITH_COLLECTIONS      optional corpus caps
 *   BENCH_PROBE_PATH / BENCH_EXPANSION_PATH / BENCH_REPORT_PATH  overrides
 *
 * Pipeline: real sources → domain parse → doc corpus + probes →
 * per-candidate embedding through the Provider seam → recall@10/MRR per
 * direction → expansion micro-task (ADR-0014) → gate evaluation → JSON
 * report written to BENCH_REPORT_PATH. The winning default lands in the
 * `embedder` role in the SAME commit as the report (AGENTS.md cost
 * discipline + recorded decision).
 */
import * as app from "@app/infra";
import * as evalpkg from "@app/eval";
import * as domain from "@app/kajianq-domain";
import {
  buildBenchmarkCorpus,
  resolveProbes,
  readFixtureJson,
  writeReportFile,
  fromCwd,
} from "./embed-bench-corpus.mjs";
import { loadCandidates, runCandidates, runExpansionCases } from "./embed-bench-runner.mjs";

const logger = app.createLogger({ script: "eval:embed-bench" });

function fail(msg) {
  console.error(`embed-bench: ${msg}`);
  process.exit(1);
}

const config = (() => {
  try {
    return evalpkg.loadEmbedBenchConfig(process.env);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
})();

const budget = new evalpkg.Budget(config.budgetCapMicroUsd);
console.log(
  `embed-bench: budget ${config.budgetCapMicroUsd === undefined ? "uncapped" : `${config.budgetCapMicroUsd} micro-USD`}`,
);

const groupACount = config.groupACap === undefined ? domain.TOTAL_SURAHS : config.groupACap;
const groupBCount =
  config.groupBCap === undefined ? domain.HADITH_COLLECTIONS.length : config.groupBCap;
const { allDocs, fingerprint, surahCount, collections } = await buildBenchmarkCorpus({
  groupACap: groupACount,
  groupBCap: groupBCount,
  docBudget: config.docBudget,
  log: logger,
});
logger.info("corpus assembled", { docs: allDocs.length, fingerprint });

const { probes, source: probeSource } = resolveProbes({
  evalpkg,
  domain,
  probePath: fromCwd(config.probePath),
  fingerprint,
  allDocs,
});
logger.info("probes ready", {
  source: probeSource,
  cross: probes.crossLingual.length,
  mono: probes.monolingual.length,
});

const providerConfig = app.loadProviderConfig();
if (!providerConfig.roles["embedder-candidates"]) {
  fail("provider config has no embedder-candidates role");
}

const fmt = (v) => (v === null ? "n/a" : v.toFixed(3));
const onCost = (cost) => {
  budget.add(cost.costMicroUsd ?? 0);
  budget.check();
};
const candidates = loadCandidates(providerConfig);
const results = await runCandidates({
  evalpkg,
  candidates,
  allDocs,
  probes,
  batchSize: config.batchSize ?? 96,
  onCost,
  onCell: (modelId, cell) =>
    console.log(
      `  ${modelId}  ${cell.direction}  recall@10=${fmt(cell.recallAtK)}  mrr=${fmt(cell.mrr)}  (n=${cell.queries})`,
    ),
  log: logger,
});
for (const r of results) console.log(`  ${r.modelId}  gate: ${JSON.stringify(r.gate)}`);

// Expansion micro-task (ADR-0014): router LLM term selection.
const expansionResults = [];
try {
  const expansionSet = evalpkg.parseExpansionSet(
    readFixtureJson(fromCwd(config.expansionPath), config.expansionPath),
    config.expansionPath,
  );
  const { provider: router } = app.resolveRole(providerConfig, "cheap", { env: process.env });
  expansionResults.push(
    ...(await runExpansionCases({
      evalpkg,
      provider: router,
      cases: expansionSet,
      budget,
      onCost,
    })),
  );
} catch (err) {
  if (err.code === "ENOENT") {
    console.error(
      `embed-bench: expansion fixture missing (${config.expansionPath}) — micro-task skipped`,
    );
  } else {
    throw err;
  }
}

const expansionAccuracy =
  expansionResults.length === 0
    ? null
    : expansionResults.filter((r) => r.correct).length / expansionResults.length;
const report = {
  id: "embed-bench-v0",
  corpusFingerprint: fingerprint,
  corpusDocs: allDocs.length,
  surahs: surahCount,
  hadithCollections: collections.length,
  probeSource,
  probes: { crossLingual: probes.crossLingual.length, monolingual: probes.monolingual.length },
  candidates: results,
  expansion: {
    cases: expansionResults.length,
    accuracy: expansionAccuracy,
    results: expansionResults,
  },
  gateFloors: evalpkg.GATE_FLOORS,
  budget: { capMicroUsd: config.budgetCapMicroUsd ?? null, totalMicroUsd: budget.total },
  finishedAt: new Date().toISOString(),
};

writeReportFile(fromCwd(config.reportPath), report);

const fmtCell = (r, d) => {
  const cell = r.cells.find((c) => c.direction === d);
  return cell === undefined || cell.recallAtK === null ? "n/a" : cell.recallAtK.toFixed(3);
};
console.log(
  [
    "",
    "embed-bench summary",
    `  corpus: ${allDocs.length} docs (fingerprint ${fingerprint})`,
    ...results.map(
      (r) =>
        `  ${r.modelId}: gate=${r.gate.gatePass} xl=${fmtCell(r, "secondary→primary")} mono=${fmtCell(r, "primary→primary")}`,
    ),
    `  expansion accuracy: ${expansionAccuracy === null ? "n/a" : expansionAccuracy.toFixed(3)} (${expansionResults.length} cases)`,
    `  cost: $${(budget.total / 1e6).toFixed(4)}  report: ${config.reportPath}`,
  ].join("\n"),
);
