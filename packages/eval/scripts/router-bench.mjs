#!/usr/bin/env bun
/**
 * router-bench.mjs — the router-classification gate CLI (ADR-0042
 * discipline over the cheap-role Smart Router stage 1–2).
 *
 *   bun run eval:router-bench [--model <config row id>] [--force] [--report-only]
 *
 * The bench store lives at repo root under `benchmarks/routing/` — sealed
 * samples, append-only run files (one per candidate arm, written once;
 * adding a candidate never re-runs the committed arms), and the
 * offline-derived report. Flags: `--model <id>` appends only that
 * cheap-candidates row; `--force` replaces a committed measurement
 * deliberately; `--report-only` regenerates report.md with no key, no
 * network, no spend. Env: `OPENROUTER_API_KEY` absent = NOT RUN, exit 0
 * (CI has no key and stays green); `EVAL_BUDGET_MICRO_USD` hard spend cap;
 * `ROUTER_BENCH_DIR` store path override. Every line goes through the
 * structured Logger adapter (thermo B1).
 *
 * The case loop rides the PRODUCTION router prompt builder and reply reader
 * (the domain pack's routerCallFor / readRouterText via the eval engine's
 * adapters), so the bench measures the read the serving path performs —
 * the same JSON extraction, vocabulary narrowing, and fallback semantics.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import * as app from "@app/infra";
import * as evalpkg from "@app/eval";
import * as domain from "@app/kajianq-domain";

const logger = app.createLogger({ script: "eval:router-bench" });

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
  if (!id) fail("--model requires a cheap-candidates config row id");
  return id;
})();
const force = args.includes("--force");
const reportOnly = args.includes("--report-only");

const config = (() => {
  const dir = process.env.ROUTER_BENCH_DIR?.trim() || "benchmarks/routing";
  let cap;
  try {
    cap = evalpkg.budgetCapFromEnv(process.env.EVAL_BUDGET_MICRO_USD);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  return { dir, cap };
})();

const fixture = (() => {
  try {
    const raw = readFileSync(fromCwd(`${config.dir}/samples/cases.json`), "utf8");
    return evalpkg.parseRouterBenchFixture(JSON.parse(raw));
  } catch (err) {
    fail(
      `router-bench fixture unreadable/invalid (${config.dir}/samples/cases.json): ${String(err)}`,
    );
  }
})();

const seal = (() => {
  try {
    return evalpkg.loadRouterBenchSeal(
      fromCwd(`${config.dir}/samples/version.json`),
      fromCwd(`${config.dir}/samples/cases.json`),
      fixture,
    );
  } catch (err) {
    fail(String(err instanceof Error ? err.message : err));
  }
})();

const caseCount = fixture.cases.length;
logger.info("sealed samples loaded", {
  sealVersion: seal.version,
  fixtureId: seal.fixture.id,
  cases: caseCount,
});

/** Regenerate report.md from the committed run files (offline; no spend). */
const regenerateReport = () => {
  const runs = evalpkg.loadRouterBenchRuns(fromCwd(`${config.dir}/runs`), seal);
  const report = evalpkg.renderRouterBenchReport({
    seal,
    runs,
    runsDir: `${config.dir}/runs`,
    generatedAt: new Date().toISOString(),
    supersededCount: evalpkg.countSupersededResults(config.dir),
  });
  const reportPath = fromCwd(`${config.dir}/report.md`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report);
  logger.info("report written", { reportPath: `${config.dir}/report.md`, runs: runs.length });
};

if (reportOnly) {
  regenerateReport();
  process.exit(0);
}

const promptsSha256 = evalpkg.routerBenchPromptsPin(domain.ROUTER_BENCH_PROMPTS_IDENTITY);
const samplesPin = evalpkg.routerBenchSamplesPin(seal);

const providerConfig = app.loadProviderConfig(process.env.PROVIDER_PROFILE);
const candidatesRole = providerConfig.roles["cheap-candidates"];
if (!candidatesRole) {
  fail("provider config has no cheap-candidates role");
}

// One candidate, one provider: the same synthetic single-role config the
// embed bench resolves candidates with, so the bench calls exactly the
// vendor the config row names and no chain fallback ever masks a candidate.
const { providers, missingKeys } = candidatesRole.chain.reduce(
  (acc, key) => {
    const sep = key.indexOf(":");
    const vendor = key.slice(0, sep);
    const modelId = key.slice(sep + 1);
    const vendorConfig = providerConfig.vendors[vendor];
    if (!vendorConfig) {
      fail(`cheap-candidates chain names unknown vendor "${vendor}" (${key})`);
    }
    if (!process.env[vendorConfig.apiKeyEnv]) {
      acc.missingKeys.push(modelId);
      return acc;
    }
    const { provider } = app.resolveRole(
      { vendors: { [vendor]: vendorConfig }, roles: { cheap: { chain: [key] } } },
      "cheap",
      { env: process.env },
    );
    acc.providers.push({ modelId, provider });
    return acc;
  },
  { providers: [], missingKeys: [] },
);

if (providers.length === 0) {
  logger.warn("no keyed routing candidates — NOT RUN", { missing: missingKeys });
  process.exit(0);
}

const selected = onlyModel
  ? (() => {
      const found = providers.filter((p) => p.modelId === onlyModel);
      if (found.length === 0) {
        fail(
          `--model "${onlyModel}" is not a keyed routing candidate; keyed: ${providers.map((p) => p.modelId).join(", ")}`,
        );
      }
      return found;
    })()
  : providers;

const budget = new evalpkg.Budget(config.cap);
logger.info("budget configured", {
  budgetCapMicroUsd: config.cap ?? null,
  candidates: selected.map((p) => p.modelId),
});

/** Build the run record for one candidate arm — the run file's whole body. */
const buildRun = (modelId, startedAt, armStartMicroUsd, outcomes, failure) => {
  const scored = outcomes.length;
  const passed = outcomes.filter((o) => o.passed).length;
  const overall = scored === 0 ? null : passed / scored;
  const gate = evalpkg.evaluateDecisionGate(outcomes);
  return {
    schema: 1,
    task: "router-bench",
    model: modelId,
    samples: samplesPin,
    promptsSha256,
    budget: {
      capMicroUsd: config.cap ?? null,
      plannedCases: caseCount,
      totalMicroUsd: budget.total - armStartMicroUsd,
    },
    totals: { cases: caseCount, scored, passed, accuracy: overall },
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
      language: o.language,
      expected: o.expected,
      got: o.got,
      passed: o.passed,
      ...(o.cost ? { cost: o.cost } : {}),
    })),
  };
};

// The production call builder and reply reader: the bench scores the read
// the serving path performs, never a bench-local re-implementation.
const adapters = {
  buildCall: (c) => {
    const call = domain.routerCallFor(c.question, c.priorTurns);
    if (call.question === undefined) {
      fail(`fixture case "${c.id}" was rejected by the router's own question admission`);
    }
    return { turns: call.turns, options: { temperature: 0 } };
  },
  readReply: (text) => domain.readRouterText(text, {}),
};

const gateResults = [];
for (const { modelId, provider } of selected) {
  logger.info("running candidate", { modelId });
  const startedAt = new Date().toISOString();
  const armStartMicroUsd = budget.total;
  const outcomes = [];
  let failure = null;
  try {
    await evalpkg.runRouterBench({
      provider,
      fixture,
      adapters,
      onCost: (cost) => {
        budget.add(cost.costMicroUsd);
        budget.check();
      },
      onOutcome: (o) => outcomes.push(o),
      wouldExceed: () => budget.wouldExceed(),
      log: logger,
    });
  } catch (err) {
    // Vendor failure: the candidate's run file still lands with its partial
    // records and the failure named (thermo A2) — then the run exits
    // non-zero, because an aborted arm may never read as a passed one.
    failure =
      err instanceof evalpkg.BudgetExceededError
        ? "budget cap exceeded"
        : String(err?.message ?? err);
    logger.error("candidate aborted", { modelId, error: failure });
  }
  const run = buildRun(modelId, startedAt, armStartMicroUsd, outcomes, failure);
  try {
    const runPath = evalpkg.writeRouterBenchRun(fromCwd(`${config.dir}/runs`), run, { force });
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
});

// Exit non-zero when every keyed candidate fails the gate, so CI (or the
// operator's muscle memory) cannot read a failed gate as a passed one.
process.exit(anyPass ? 0 : 1);
