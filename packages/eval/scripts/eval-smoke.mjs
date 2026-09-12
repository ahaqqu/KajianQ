#!/usr/bin/env bun
/**
 * eval-smoke.mjs — the `eval:smoke` Golden Set smoke subset (ticket #10).
 *
 *   bun run eval:smoke
 *
 * Runs a small, stratified slice of the Golden Set against a target
 * `/v1/chat`, through the same harness and the same ledger as the full run
 * (`eval:run`). The subset is chosen deterministically by
 * `selectSmokeSubset` — refusal, trap, English, and Indonesian cases first,
 * then fill — so a PR-time gate cannot pass by accident on easy questions
 * alone.
 *
 * Env (the same validated config as `eval:run`, plus one knob):
 *   EVAL_API_BASE_URL      the staging /v1/chat origin (required)
 *   EVAL_API_TOKEN         an anonymous Bearer token minted by the API
 *                          (required; `POST /v1/auth/anonymous` mints one)
 *   NEON_DATABASE_URL      the staging Neon store to read answer traces from
 *                          and persist the run into (required)
 *   EVAL_BUDGET_MICRO_USD  hard spend cap in micro-USD (unset/0 = uncapped)
 *   EVAL_SMOKE_SIZE        subset size (default 5, the spec's PR-time size)
 *   EVAL_GOLDEN_SET_PATH   optional fixture path override
 *   EVAL_RUN_LABEL         optional run label
 *
 * Exit code is non-zero when any smoke question fails, so CI can gate on it.
 * A live run needs staging secrets (Cloudflare + Neon + vendor keys); when
 * they are absent the script fails fast with the missing name rather than
 * reporting a misleading pass — see the run instructions in SPECS §3.7.
 *
 * Round-3 B2: the config load, budget banner, fixture load, and summary
 * printer are the shared CLI glue in `eval-cli.mjs` — one copy, no drift.
 * This script keeps only what is genuinely its own: the subset selection and
 * the failure exit policy.
 */
import * as evalpkg from "@app/eval";
import { createStagingHarness } from "./staging-harness.mjs";
import { createBudget, fail, loadConfig, loadFixture, printSummary } from "./eval-cli.mjs";

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

const selection = evalpkg.selectSmokeSubset(fixture, { size, trapTag: "dhaif-trap" });
console.log(
  [
    `eval:smoke: ${selection.set.questions.length} of ${fixture.questions.length} questions from "${fixture.id}"`,
    ...selection.reasons.map((r) => `  ${r.id}: ${r.reason}`),
  ].join("\n"),
);

// B2: the staging bootstrap (store, sourceType scan, transport, traces,
// ledger, refusal markers) is shared with eval:run — one copy, no drift.
const harness = await createStagingHarness(config, budget);

const label = config.runLabel ?? `${fixture.id}-smoke`;
const result = await evalpkg.runGoldenSet(selection.set, {
  transport: harness.transport,
  traces: harness.traces,
  ledger: harness.ledger,
  sourceTypeOf: harness.sourceTypeOf,
  refusalMarkers: harness.refusalMarkers,
  label,
  budget,
});

// The live budget is the settled figure here: a smoke run may abort on the
// cap before the ledger row is written, and the run's own record would then
// understate the spend.
printSummary("eval:smoke", {
  runId: result.runId,
  questionCount: selection.set.questions.length,
  result,
  costMicroUsd: budget.total,
});

if (result.failed > 0 || result.skipped > 0) {
  console.error(
    `eval:smoke: FAILED — ${result.failed} failed, ${result.skipped} skipped. See eval_results for run ${result.runId}.`,
  );
  process.exit(1);
}
console.log("eval:smoke: PASSED");
