#!/usr/bin/env bun
/**
 * eval-run.mjs — the `eval:run` Golden Set CLI (issue #8).
 *
 *   bun run eval:run
 *
 * Env (validated by `loadEvalRunConfig` before any spend):
 *   EVAL_API_BASE_URL      the staging /v1/chat origin (required)
 *   EVAL_API_TOKEN         an anonymous Bearer token minted by the API (required)
 *   NEON_DATABASE_URL      the staging Neon store to read answer traces from
 *                          and persist eval_runs/eval_results into (required)
 *   EVAL_BUDGET_MICRO_USD  hard spend cap in micro-USD; the run aborts when
 *                          the cap is hit (harness LLM calls + the pipeline
 *                          costs recorded in each answer trace). Unset or 0
 *                          = explicit opt-out; an empty value fails fast.
 *   EVAL_RUN_LABEL         optional run label (defaults to the fixture id)
 *   EVAL_GOLDEN_SET_PATH   optional fixture path override (defaults to the
 *                          domain pack's golden-set-v0.json, resolved from
 *                          the repo root — thermo-review A2)
 *
 * Thin composition root (B5): wires the SSE client + the Neon store through
 * the @app/eval seams, runs the harness (`runGoldenSet` owns the run
 * lifecycle — no re-implemented loop, no ledger mutation, thermo-review
 * A3/A4/A9/B1), and prints the summary. Missing API keys are reported NOT
 * RUN (same posture as provider-smoke): the harness aborts because it needs
 * the staging API to be serving.
 *
 * Round-3 B2: the config load, budget banner, fixture load, and summary
 * printer are the shared CLI glue in `eval-cli.mjs` — one copy, no drift.
 * This script keeps only what is genuinely its own: the v0 content-bar
 * assertion, the golden-set banner line, and the ledger-backed cost figure
 * in the summary.
 */
import * as evalpkg from "@app/eval";
import { createStagingHarness } from "./staging-harness.mjs";
import { createBudget, loadConfig, loadFixture, printSummary } from "./eval-cli.mjs";

const config = loadConfig("eval:run", process.env);
const budget = createBudget("eval:run", config);

// The Golden Set fixture — validated against the contract, then against the
// v0 content bar (the trap-tag label is the domain's vocabulary). A2: the
// path comes from the validated config (EVAL_GOLDEN_SET_PATH), not a
// hard-coded cross-package URL.
const fixture = loadFixture("eval:run", config, { assertV0: true });
console.log(
  `eval:run: golden set "${fixture.id}" — ${fixture.questions.length} questions, status ${fixture.status}`,
);

// B2: the staging seams (store, sourceType scan, transport, traces, ledger,
// refusal markers) come from the shared bootstrap — one copy, no drift.
const harness = await createStagingHarness(config, budget);

const harnessResult = await evalpkg.runGoldenSet(fixture, {
  transport: harness.transport,
  traces: harness.traces,
  ledger: harness.ledger,
  sourceTypeOf: harness.sourceTypeOf,
  refusalMarkers: harness.refusalMarkers,
  ...(config.runLabel !== undefined ? { label: config.runLabel } : {}),
  budget,
});

const r = harnessResult;
const report = await harness.runStore(harness.store.getEvalRun(r.runId));
printSummary("eval:run", {
  runId: r.runId,
  questionCount: fixture.questions.length,
  result: r,
  costMicroUsd: report?.costMicroUsd ?? budget.total,
});
