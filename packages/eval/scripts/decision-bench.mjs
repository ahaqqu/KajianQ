#!/usr/bin/env bun
/**
 * decision-bench.mjs — the multilingual decision-model gate CLI (ADR-0042).
 *
 *   bun run eval:decision-bench
 *
 * Env (validated by loadDecisionBenchConfig before any spend):
 *   JEV_API_KEY       the decision vendor key; ABSENT = the run reports
 *                          NOT RUN and exits 0 — CI has no key and stays
 *                          green (mirrors provider-smoke's NOT RUN posture)
 *   EVAL_BUDGET_MICRO_USD  optional hard spend cap in micro-USD
 *   DECISION_BENCH_FIXTURE_PATH / DECISION_BENCH_REPORT_PATH  overrides
 *
 * Pipeline: load the versioned fixture (hard-fail on a malformed file — a
 * fixture that silently drops cases lies about coverage) → resolve every
 * decision-candidates chain entry through the Decider seam → run the
 * relevance/rerank/citation cases per language → gate evaluation (overall
 * ≥ 0.85 AND each language ≥ 0.75) → JSON report. The report lands next to
 * the fixtures; adoption in any pipeline stage is a future ADR gated on
 * this run's numbers.
 *
 * Thermo B1: every line goes through the structured Logger adapter — no
 * bare console output.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

const caseCount = fixture.relevance.length + fixture.rerank.length + fixture.citation.length;
const languages = [
  ...new Set([...fixture.relevance, ...fixture.rerank, ...fixture.citation].map((c) => c.language)),
];
logger.info("fixture loaded", {
  fixtureId: fixture.id,
  status: fixture.status,
  cases: caseCount,
  languages,
});

const providerConfig = app.loadProviderConfig();
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

const budget = new evalpkg.Budget(config.budgetCapMicroUsd);
logger.info("budget configured", { budgetCapMicroUsd: config.budgetCapMicroUsd ?? null });

/** Write the report file from whatever state exists — the failure path
 * owes a citable report too (thermo A2): recorded spend and completed
 * outcomes are never lost to an abort or vendor failure. */
const writeReport = (aborted) => {
  const report = {
    id: "decision-bench-v0",
    fixtureId: fixture.id,
    fixtureStatus: fixture.status,
    cases: caseCount,
    languages,
    aborted: aborted === true,
    gateFloors: evalpkg.DECISION_GATE_FLOORS,
    candidates: results,
    budget: { capMicroUsd: config.budgetCapMicroUsd ?? null, totalMicroUsd: budget.total },
    finishedAt: new Date().toISOString(),
  };
  const reportPath = fromCwd(config.reportPath);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  logger.warn("partial report written (run aborted)", { reportPath: config.reportPath });
};

const results = [];
try {
  for (const { modelId, decider } of deciders) {
    logger.info("running candidate", { modelId });
    let outcomes;
    try {
      outcomes = await evalpkg.runDecisionBench({
        decider,
        fixture,
        prompts: domain.DECISION_BENCH_PROMPTS,
        onCost: (cost) => {
          budget.add(cost.costMicroUsd);
          budget.check();
        },
        wouldExceed: () => budget.wouldExceed(),
        log: logger,
      });
    } catch (err) {
      // Budget abort or vendor failure: the partial report still lands
      // (thermo A2), then the run exits non-zero — an aborted gate may
      // never read as a passed one.
      writeReport(true);
      if (err instanceof evalpkg.BudgetExceededError) {
        logger.error("budget exceeded — aborting run", { modelId });
      } else {
        logger.error(`decision-bench: candidate ${modelId} failed: ${String(err?.message ?? err)}`);
      }
      process.exit(1);
    }
    const gate = evalpkg.evaluateDecisionGate(outcomes);
    const perLanguage = evalpkg.accuracyByLanguage(outcomes);
    const perTask = evalpkg.accuracyByTask(outcomes);
    results.push({ modelId, gate, perLanguage, perTask, outcomes });
    logger.info("candidate scored", {
      modelId,
      gatePass: gate.gatePass,
      overallAccuracy: evalpkg.meanAccuracy(outcomes),
      failedLanguages: gate.failedLanguages,
    });
  }
} catch (err) {
  // Belt-and-braces: any unexpected failure still owes the partial report.
  writeReport(true);
  throw err;
}

const report = {
  id: "decision-bench-v0",
  fixtureId: fixture.id,
  fixtureStatus: fixture.status,
  cases: caseCount,
  languages,
  aborted: false,
  gateFloors: evalpkg.DECISION_GATE_FLOORS,
  candidates: results,
  budget: { capMicroUsd: config.budgetCapMicroUsd ?? null, totalMicroUsd: budget.total },
  finishedAt: new Date().toISOString(),
};

const reportPath = fromCwd(config.reportPath);
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
logger.info("report written", { reportPath: config.reportPath });

const anyPass = results.some((r) => r.gate.gatePass);
logger.info("summary", {
  candidates: results.map((r) => ({ modelId: r.modelId, gatePass: r.gate.gatePass })),
  anyGatePass: anyPass,
  totalMicroUsd: budget.total,
  reportPath: config.reportPath,
});

// Exit non-zero when every keyed candidate fails the gate, so CI (or the
// operator's muscle memory) cannot read a failed gate as a passed one.
process.exit(anyPass ? 0 : 1);
