#!/usr/bin/env bun
/**
 * decision-bench.mjs — the multilingual decision-model gate CLI (ADR-0042).
 *
 *   bun run eval:decision-bench [--model <config row id>] [--force] [--report-only]
 *
 * The bench store lives at repo root under `benchmarks/decisions/`: the
 * sealed samples (`samples/cases.json` + `samples/version.json`), the
 * append-only run files (`runs/<model-slug>.json`, one per candidate arm),
 * and the generated report (`report.md` — derived offline from the
 * committed files, never hand-edited). A run file is written once; adding
 * a candidate (`--model`) never re-runs the committed arms.
 *
 * Flags:
 *   --model <id>   run only this decision-candidates config row (append a
 *                  new arm without re-benchmarking the committed ones)
 *   --force        replace an existing run file for the same model — the
 *                  deliberate re-run escape hatch; the replacement is the
 *                  same PR's evidence
 *   --report-only  regenerate report.md from the committed files — no key,
 *                  no network, no spend
 *
 * Env (validated by loadDecisionBenchConfig before any spend):
 *   OPENROUTER_API_KEY  the decision vendor key; ABSENT = the run reports
 *                        NOT RUN and exits 0 — CI has no key and stays
 *                        green (mirrors provider-smoke's NOT RUN posture)
 *   EVAL_BUDGET_MICRO_USD  optional hard spend cap in micro-USD
 *   DECISION_BENCH_DIR / DECISION_BENCH_FIXTURE_PATH /
 *   DECISION_BENCH_REPORT_PATH  store path overrides
 *
 * Pipeline: load the sealed fixture (hash + counts verified before any
 * spend) → resolve the decision-candidates chain through the Decider seam
 * → run the relevance/rerank/citation cases per language per candidate →
 * one run file per candidate (an aborted candidate keeps its partial
 * records and names the failure) → gate evaluation (overall ≥ 0.85 AND
 * each language ≥ 0.75) → regenerate the report. Adoption in any pipeline
 * stage is a config change gated on a passing report — never this script.
 *
 * Thermo B1: every line goes through the structured Logger adapter — no
 * bare console output.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import * as app from "@app/infra";
import * as evalpkg from "@app/eval";
import * as domain from "@app/kajianq-domain";

const logger = app.createLogger({ script: "eval:decision-bench" });

function fail(msg) {
  logger.error(msg);
  process.exit(1);
}

const fromCwd = (p) => resolvePath(process.cwd(), p);

const args = process.argv.slice(2);
const onlyModel = (() => {
  const i = args.indexOf("--model");
  if (i === -1) return null;
  const id = args[i + 1];
  if (!id) fail("--model requires a decision-candidates config row id");
  return id;
})();
const force = args.includes("--force");
const reportOnly = args.includes("--report-only");

const config = (() => {
  try {
    return evalpkg.loadDecisionBenchConfig(process.env);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
})();

const fixture = (() => {
  try {
    const raw = readFileSync(fromCwd(config.fixturePath), "utf8");
    return evalpkg.loadDecisionBenchFixtureJson(raw, config.fixturePath);
  } catch (err) {
    fail(`decision-bench fixture unreadable/invalid (${config.fixturePath}): ${String(err)}`);
  }
})();

const seal = (() => {
  try {
    return evalpkg.loadDecisionBenchSeal(
      fromCwd(config.sealPath),
      fromCwd(config.fixturePath),
      fixture,
    );
  } catch (err) {
    fail(String(err instanceof Error ? err.message : err));
  }
})();

const caseCount = fixture.relevance.length + fixture.rerank.length + fixture.citation.length;
logger.info("sealed samples loaded", {
  sealVersion: seal.version,
  fixtureId: seal.fixture.id,
  cases: caseCount,
});

/** Regenerate report.md from the committed run files (offline; no spend). */
const regenerateReport = () => {
  const runs = evalpkg.loadDecisionBenchRuns(fromCwd(config.runsDir), seal);
  const report = evalpkg.renderDecisionBenchReport({
    seal,
    runs,
    runsDir: config.runsDir,
    generatedAt: new Date().toISOString(),
    supersededCount: evalpkg.countSupersededResults(config.dir),
  });
  const reportPath = fromCwd(config.reportPath);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report);
  logger.info("report written", { reportPath: config.reportPath, runs: runs.length });
};

if (reportOnly) {
  regenerateReport();
  process.exit(0);
}

const promptsSha256 = evalpkg.decisionBenchPromptsPin(
  evalpkg.decisionBenchPromptsIdentity(
    domain.DECISION_BENCH_PROMPTS_IDENTITY,
    app.DECISION_SYSTEM_PROMPT,
  ),
);
const samplesPin = evalpkg.decisionBenchSamplesPin(seal);

/** Build the run record for one candidate arm — the run file's whole body. */
const buildRun = (modelId, startedAt, armStartMicroUsd, outcomes, failure) => {
  const scored = outcomes.length;
  const passed = outcomes.filter((o) => o.passed).length;
  const gate = evalpkg.evaluateDecisionGate(outcomes);
  return {
    schema: 1,
    task: "decision-bench",
    model: modelId,
    samples: samplesPin,
    promptsSha256,
    budget: {
      capMicroUsd: config.budgetCapMicroUsd ?? null,
      plannedCases: caseCount,
      totalMicroUsd: budget.total - armStartMicroUsd,
    },
    totals: {
      cases: caseCount,
      scored,
      passed,
      accuracy: scored === 0 ? null : passed / scored,
    },
    gate: {
      gatePass: gate.gatePass,
      overallAccuracy: evalpkg.meanAccuracy(outcomes),
      failedLanguages: gate.failedLanguages,
      floors: evalpkg.DECISION_GATE_FLOORS,
    },
    ...(failure ? { aborted: true, error: failure } : {}),
    startedAt,
    finishedAt: new Date().toISOString(),
    records: outcomes.map((o) => ({
      caseId: o.caseId,
      task: o.task,
      language: o.language,
      expected: o.expected,
      got: o.got,
      passed: o.passed,
      ...(o.cost ? { cost: o.cost } : {}),
    })),
  };
};

const providerConfig = app.loadProviderConfig(process.env.PROVIDER_PROFILE);
if (!providerConfig.roles["decision-candidates"]) {
  fail("provider config has no decision-candidates role");
}

const { deciders, missingKeys } = app.resolveDecider(providerConfig, "decision-candidates", {
  env: process.env,
});
if (deciders.length === 0) {
  logger.warn("no keyed decision candidates — NOT RUN", { missing: missingKeys });
  process.exit(0);
}

const selected = onlyModel
  ? (() => {
      const found = deciders.filter((d) => d.modelId === onlyModel);
      if (found.length === 0) {
        fail(
          `--model "${onlyModel}" is not a keyed decision candidate; keyed: ${deciders.map((d) => d.modelId).join(", ")}`,
        );
      }
      return found;
    })()
  : deciders;

const budget = new evalpkg.Budget(config.budgetCapMicroUsd);
logger.info("budget configured", {
  budgetCapMicroUsd: config.budgetCapMicroUsd ?? null,
  candidates: selected.map((d) => d.modelId),
});

const gateResults = [];
for (const { modelId, decider } of selected) {
  logger.info("running candidate", { modelId });
  const startedAt = new Date().toISOString();
  const armStartMicroUsd = budget.total;
  const outcomes = [];
  let failure = null;
  try {
    await evalpkg.runDecisionBench({
      decider,
      fixture,
      prompts: domain.DECISION_BENCH_PROMPTS,
      onCost: (cost) => {
        budget.add(cost.costMicroUsd);
        budget.check();
      },
      onOutcome: (o) => outcomes.push(o),
      wouldExceed: () => budget.wouldExceed(),
      log: logger,
    });
  } catch (err) {
    // Budget abort or vendor failure: the candidate's run file still lands
    // with its partial records and the failure named (thermo A2) — then the
    // run exits non-zero, because an aborted arm may never read as a passed
    // one.
    failure =
      err instanceof evalpkg.BudgetExceededError
        ? "budget cap exceeded"
        : String(err?.message ?? err);
    logger.error("candidate aborted", { modelId, error: failure });
  }
  const run = buildRun(modelId, startedAt, armStartMicroUsd, outcomes, failure);
  try {
    const runPath = evalpkg.writeDecisionBenchRun(fromCwd(config.runsDir), run, { force });
    logger.info("run file written", { runPath, scored: run.totals.scored });
  } catch (err) {
    fail(String(err instanceof Error ? err.message : err));
  }
  gateResults.push({ modelId, gatePass: run.gate.gatePass, aborted: failure !== null });
  if (failure) process.exit(1);
}

regenerateReport();

const anyPass = gateResults.some((r) => r.gatePass);
logger.info("summary", {
  candidates: gateResults,
  anyGatePass: anyPass,
  totalMicroUsd: budget.total,
  reportPath: config.reportPath,
});

// Exit non-zero when every keyed candidate fails the gate, so CI (or the
// operator's muscle memory) cannot read a failed gate as a passed one.
process.exit(anyPass ? 0 : 1);
