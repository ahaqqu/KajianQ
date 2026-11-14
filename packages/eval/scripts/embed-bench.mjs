#!/usr/bin/env bun
/**
 * embed-bench.mjs — the embedding-benchmark CLI (issue #9, ADR-0013/0014
 * go/no-go gate for the retrieval posture).
 *
 *   bun run eval:embed-bench [--model <candidate id>] [--force] [--report-only]
 *
 * The bench store lives at repo root under `benchmarks/embeddings/`: the
 * sealed samples (`samples/probes.json` + `samples/expansion-cases.json` +
 * `samples/version.json`), the append-only run files (`runs/<slug>.json`, one
 * per candidate arm), and the generated report (`report.md` — derived offline
 * from the committed files, never hand-edited). A run file is written once;
 * adding a candidate (`--model`) never re-runs the committed arms.
 *
 * Flags:
 *   --model <id>   run only this embedder-candidates model id (append a new
 *                  arm without re-benchmarking the committed ones)
 *   --force        replace an existing run file for the same model — the
 *                  deliberate re-run escape hatch; the replacement is the
 *                  same PR's evidence
 *   --report-only  regenerate report.md from the committed files — no key,
 *                  no network, no spend
 *
 * Env (validated by loadEmbedBenchConfig before any spend):
 *   DATABASE_URL     optional (validated URL-shape when set; the run is
 *                    source-based and DB-free — thermo B5)
 *   <each candidate's key env, from the embedder-candidates vendor config>
 *                    absent = fail fast, never silently skip a candidate —
 *                    the gate measures every arm or it measures nothing
 *   EVAL_BUDGET_MICRO_USD  optional hard spend cap in micro-USD
 *   BENCH_GROUP_A / BENCH_GROUP_B  optional corpus caps
 *   BENCH_DOC_BUDGET / BENCH_BATCH_SIZE  corpus subset and embedding batch
 *   EMBED_BENCH_DIR / BENCH_PROBE_PATH / BENCH_EXPANSION_PATH /
 *   BENCH_REPORT_PATH  store path overrides
 *
 * Pipeline: sealed samples verified (hashes + corpus fingerprint, before any
 * spend) → real sources → domain parse → doc corpus + probes → per-candidate
 * embedding through the Provider seam → recall@10/MRR per direction → the
 * ADR-0014 expansion micro-task per arm → gate evaluation → one run file per
 * candidate → report regenerated. The winning default lands in the
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
  writeTextFile,
  fromCwd,
} from "./embed-bench-corpus.mjs";
import { loadCandidates, runCandidates, runExpansionCases } from "./embed-bench-runner.mjs";

const logger = app.createLogger({ script: "eval:embed-bench" });

function fail(msg) {
  logger.error(msg);
  process.exit(1);
}

const args = process.argv.slice(2);
const modelFlag = args.indexOf("--model");
const onlyModel = modelFlag === -1 ? null : args[modelFlag + 1];
if (modelFlag !== -1 && !onlyModel) fail("--model requires an embedder-candidates model id");
const force = args.includes("--force");
const reportOnly = args.includes("--report-only");

const config = (() => {
  try {
    return evalpkg.loadEmbedBenchConfig(process.env);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
})();

/** The sealed samples, loaded and verified before anything else can spend. */
const seal = (() => {
  try {
    const probes = evalpkg.parseProbeSet(
      readFixtureJson(fromCwd(config.probePath), config.probePath),
      config.probePath,
    );
    const expansion = evalpkg.parseExpansionSet(
      readFixtureJson(fromCwd(config.expansionPath), config.expansionPath),
      config.expansionPath,
    );
    const verified = evalpkg.loadEmbedBenchSeal(
      fromCwd(config.sealPath),
      fromCwd(config.probePath),
      fromCwd(config.expansionPath),
      probes,
      expansion,
    );
    logger.info("sealed samples loaded", {
      sealVersion: verified.version,
      probes: verified.counts.crossLingual + verified.counts.monolingual,
      expansionCases: verified.counts.expansion,
      corpusFingerprint: verified.fingerprints.corpus,
    });
    return { verified, expansionCases: expansion.cases };
  } catch (err) {
    fail(String(err instanceof Error ? err.message : err));
  }
})();

/** Regenerate report.md from the committed run files (offline; no spend). */
const regenerateReport = () => {
  const runs = evalpkg.loadEmbedBenchRuns(fromCwd(config.runsDir), seal.verified);
  const report = evalpkg.renderEmbedBenchReport({
    seal: seal.verified,
    runs,
    runsDir: config.runsDir,
    generatedAt: new Date().toISOString(),
    supersededCount: evalpkg.countSupersededResults(config.dir),
  });
  writeTextFile(fromCwd(config.reportPath), report);
  logger.info("report written", { reportPath: config.reportPath, runs: runs.length });
};

if (reportOnly) {
  regenerateReport();
  process.exit(0);
}

// Fail-fast key posture (unchanged): every candidate's key must be present
// before any spend — loadCandidates throws on the first missing one.
const providerConfig = app.loadProviderConfig(process.env.PROVIDER_PROFILE);
if (!providerConfig.roles["embedder-candidates"]) {
  fail("provider config has no embedder-candidates role");
}
let candidates;
try {
  candidates = loadCandidates(providerConfig, process.env);
} catch (err) {
  fail(String(err instanceof Error ? err.message : err));
}
const selected = onlyModel ? candidates.filter((c) => c.modelId === onlyModel) : candidates;
if (selected.length === 0) {
  fail(
    onlyModel
      ? `--model "${onlyModel}" is not a keyed embedder candidate; keyed: ${candidates.map((c) => c.modelId).join(", ")}`
      : "no embedder candidates resolved — the embedder-candidates chain is empty",
  );
}

// The expansion micro-task's router is arm-independent but its spend is not —
// resolved before any spend so a missing router key fails fast too.
const { provider: router } = app.resolveRole(providerConfig, "cheap", { env: process.env });

const budget = new evalpkg.Budget(config.budgetCapMicroUsd);
logger.info("budget configured", {
  budgetCapMicroUsd: config.budgetCapMicroUsd ?? null,
  candidates: selected.map((c) => c.modelId),
});

const batchSize = config.batchSize ?? 96;
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

const samplesPin = evalpkg.embedBenchSamplesPin(seal.verified);
const plannedCalls = 2 * Math.ceil(allDocs.length / batchSize) + seal.expansionCases.length;

const gateResults = [];
for (const candidate of selected) {
  logger.info("running candidate", { modelId: candidate.modelId });
  const startedAt = new Date().toISOString();
  const armStart = budget.total;
  let result = null;
  let expansionResults = [];
  let failure = null;
  try {
    const results = await runCandidates({
      evalpkg,
      candidates: [candidate],
      allDocs,
      probes,
      batchSize,
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
    result = results[0] ?? null;
  } catch (err) {
    // Budget abort or vendor failure: the candidate's run file still lands —
    // empty records and the failure named — then the run exits non-zero,
    // because an aborted arm may never read as a passed one.
    failure =
      err instanceof evalpkg.BudgetExceededError
        ? "budget cap exceeded"
        : String(err?.message ?? err);
    logger.error("candidate aborted", { modelId: candidate.modelId, error: failure });
  }
  if (!failure) {
    expansionResults = await runExpansionCases({
      evalpkg,
      provider: router,
      cases: seal.expansionCases,
      budget,
      onCost: (cost) => {
        budget.add(cost.costMicroUsd ?? 0);
        budget.check();
      },
      systemPrompt: domain.EXPANSION_SYSTEM_PROMPT,
      userPrompt: domain.expansionUserPrompt,
      log: logger,
    });
    if (expansionResults.length < seal.expansionCases.length) {
      failure = `budget cap hit — expansion task truncated (${expansionResults.length} of ${seal.expansionCases.length} cases)`;
      logger.error("candidate aborted", { modelId: candidate.modelId, error: failure });
    }
  }
  const run = evalpkg.buildEmbedBenchRun({
    model: candidate.modelId,
    startedAt,
    samples: samplesPin,
    budget: {
      capMicroUsd: config.budgetCapMicroUsd ?? null,
      plannedCalls,
      totalMicroUsd: budget.total - armStart,
    },
    floors: evalpkg.GATE_FLOORS,
    cells: result ? result.cells : [],
    expansionResults,
    failure: failure ?? undefined,
  });
  try {
    const runPath = evalpkg.writeEmbedBenchRun(fromCwd(config.runsDir), run, { force });
    logger.info("run file written", { runPath, records: run.records.length });
  } catch (err) {
    fail(String(err instanceof Error ? err.message : err));
  }
  gateResults.push({
    modelId: candidate.modelId,
    gatePass: run.gate.gatePass,
    aborted: failure !== null,
  });
  regenerateReport();
  if (failure) process.exit(1);
}

// Exit non-zero when every keyed candidate fails the gate, so CI (or the
// operator's muscle memory) cannot read a failed gate as a passed one.
const anyPass = gateResults.some((r) => r.gatePass);
logger.info("summary", {
  corpusDocs: allDocs.length,
  surahs: surahCount,
  hadithCollections: collections.length,
  corpusFingerprint: fingerprint,
  candidates: gateResults,
  anyGatePass: anyPass,
  totalMicroUsd: budget.total,
  reportPath: config.reportPath,
});
process.exit(anyPass ? 0 : 1);
