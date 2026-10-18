#!/usr/bin/env bun
/**
 * eval-smoke.mjs — the `eval:smoke` Golden Set smoke subset (`bun run eval:smoke`).
 *
 * Runs a small, stratified slice of the Golden Set against a target `/v1/chat`,
 * through the same harness and ledger as the full run (`eval:run`). `selectSmokeSubset`
 * picks it deterministically — refusal, the label classes the product requires, English
 * and Indonesian cases first, then fill — so the deployed gate cannot pass by accident on
 * easy questions alone.
 *
 * Env (the same validated config as `eval:run`, plus one knob):
 *   EVAL_API_BASE_URL      the staging /v1/chat origin (required)
 *   EVAL_API_TOKEN         an anonymous Bearer token (required)
 *   DATABASE_URL           the staging store for traces and run rows (required)
 *   EVAL_BUDGET_MICRO_USD  hard spend cap in micro-USD (unset/0 = uncapped)
 *   EVAL_SMOKE_SIZE        subset size (default 5 — the deployed smoke's default size)
 *
 * Exit code is non-zero when any smoke question fails, is skipped, or was never
 * measured — the shared `exitPolicy` in `eval-cli.mjs`, the same one `eval:run`
 * applies. A skipped question is UNMEASURED, not passed: "we could not ask" must
 * redden exactly as loudly as "we asked and the answer was wrong", or a transport
 * outage would buy a green release; the budget abort is the same case, since the
 * harness stops the loop on the cap without recording the remainder. Every skip and
 * scored failure is persisted and printed with its cause.
 *
 * A live run needs staging secrets (the VPS store URL + vendor keys); absent them
 * the script fails fast with the missing name. Run instructions: SPECS §3.7.
 *
 * The config load, budget banner, fixture load, summary printer and exit policy are
 * the shared CLI glue in `eval-cli.mjs`; this script keeps only the subset selection.
 */
import * as evalpkg from "@app/eval";
// The required coverage classes and the held-out cases are the domain pack's
// vocabulary, imported so a rename cannot strand the gate.
import { SMOKE_COVERAGE_TAGS, SMOKE_HELD_OUT_IDS } from "@app/kajianq-domain";
import { createStagingHarness } from "./staging-harness.mjs";
import {
  createBudget,
  exitWithPolicy,
  fail,
  loadConfig,
  loadFixture,
  printSummary,
} from "./eval-cli.mjs";

const config = loadConfig("eval:smoke", process.env);

const size = (() => {
  const raw = process.env.EVAL_SMOKE_SIZE;
  if (raw === undefined || raw.trim() === "") return 5;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    fail(`EVAL_SMOKE_SIZE must be a positive integer, got "${raw}"`);
  }
  return n;
})();

const budget = createBudget("eval:smoke", config);
const fixture = loadFixture("eval:smoke", config);

const selection = (() => {
  try {
    return evalpkg.selectSmokeSubset(fixture, {
      size,
      requiredTags: SMOKE_COVERAGE_TAGS,
      exclude: SMOKE_HELD_OUT_IDS,
    });
  } catch (err) {
    // A fixture that no longer carries a required coverage class must redden
    // the gate, not shrink it: the selector refuses to skip that class silently.
    fail("eval:smoke", err instanceof Error ? err.message : String(err));
  }
})();
console.log(evalpkg.formatSmokePlan(selection, fixture).join("\n"));

// The staging bootstrap (store, sourceType scan, transport, traces, ledger, refusal
// markers) is shared with eval:run — one copy, no drift.
const harness = await createStagingHarness(config, budget);

const label = config.runLabel ?? `${fixture.id}-smoke`;
const result = await evalpkg.runGoldenSet(selection.set, {
  transport: harness.transport,
  traces: harness.traces,
  ledger: harness.ledger,
  sourceTypeOf: harness.sourceTypeOf,
  refusalMarkers: harness.refusalMarkers,
  citationGrammar: harness.citationGrammar,
  expansionOrigin: harness.expansionOrigin,
  label,
  budget,
});

// The live budget is the settled figure here: a smoke run may abort on the cap before
// the ledger row is written, and the run's own record would then understate the spend.
printSummary("eval:smoke", {
  runId: result.runId,
  questionCount: selection.set.questions.length,
  result,
  costMicroUsd: budget.total,
  questions: fixture.questions,
});

// The shared policy: a skip fails the gate exactly as a failure does, and so does a
// question the budget cap left unmeasured. `questionCount` is the subset actually
// asked — not the fixture's full count, which would read as truncated.
exitWithPolicy("eval:smoke", {
  runId: result.runId,
  questionCount: selection.set.questions.length,
  result,
});
