#!/usr/bin/env bun
/**
 * embed-bench.mjs — the embedding-benchmark CLI (issue #9, ADR-0013/0014
 * go/no-go gate for the retrieval posture).
 *
 *   bun run eval:embed-bench
 *
 * Env (validated by loadEmbedBenchConfig before any spend):
 *   NEON_DATABASE_URL     optional (validated URL-shape when set; the run is
 *                         source-based and DB-free — thermo B5)
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
 *
 * Thermo B1: every line goes through the structured Logger adapter — no
 * bare console output. Thermo C1: the expansion fixture is required (the
 * micro-task is part of the ADR-0036 gate); a missing fixture is a hard
 * failure, not a silent skip.
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
  logger.error(msg);
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
logger.info("budget configured", {
  budgetCapMicroUsd: config.budgetCapMicroUsd ?? null,
});

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

const candidates = loadCandidates(providerConfig, process.env);
const results = await runCandidates({
  evalpkg,
  candidates,
  allDocs,
  probes,
  batchSize: config.batchSize ?? 96,
  onCost: (cost) => {
    budget.add(cost.costMicroUsd ?? 0);
    budget.check();
  },
  onCell: (modelId, cell) =>
    logger.info("cell scored", {
      modelId,
      direction: cell.direction,
      recallAtK: cell.recallAtK,
      mrr: cell.mrr,
      queries: cell.queries,
    }),
  log: logger,
});
for (const r of results) {
  logger.info("gate evaluated", { modelId: r.modelId, gate: r.gate });
}

// Expansion micro-task (ADR-0014): router LLM term selection. The fixture is
// required (thermo C1 — ADR-0036's gate includes the micro-task; a missing
// file is a hard failure), and the prompt template arrives opaque from the
// domain pack (thermo A1).
const expansionSet = (() => {
  try {
    return evalpkg.parseExpansionSet(
      readFixtureJson(fromCwd(config.expansionPath), config.expansionPath),
      config.expansionPath,
    );
  } catch (err) {
    fail(
      `expansion fixture unreadable/invalid (${config.expansionPath}): ` +
        `${err instanceof Error ? err.message : String(err)} — the ADR-0014 micro-task is part of the gate`,
    );
  }
})();
const { provider: router } = app.resolveRole(providerConfig, "cheap", { env: process.env });
const expansionResults = await runExpansionCases({
  evalpkg,
  provider: router,
  cases: expansionSet.cases,
  budget,
  onCost: (cost) => {
    budget.add(cost.costMicroUsd ?? 0);
    budget.check();
  },
  systemPrompt: domain.EXPANSION_SYSTEM_PROMPT,
  userPrompt: domain.expansionUserPrompt,
  log: logger,
});

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

logger.info("summary", {
  corpusDocs: allDocs.length,
  corpusFingerprint: fingerprint,
  candidates: results.map((r) => ({
    modelId: r.modelId,
    gatePass: r.gate.gatePass,
    crossLingualRecallAtK:
      r.cells.find((c) => c.direction === "secondary→primary")?.recallAtK ?? null,
    monolingualRecallAtK: r.cells.find((c) => c.direction === "primary→primary")?.recallAtK ?? null,
  })),
  expansionCases: expansionResults.length,
  expansionAccuracy,
  totalMicroUsd: budget.total,
  reportPath: config.reportPath,
});
