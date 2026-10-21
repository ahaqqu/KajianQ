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
 * Wait/retry policy (the readiness gate in `readiness.mjs`, which owns the details):
 * before the first question the smoke polls `GET /v1/health` until it answers 2xx,
 * for at most READINESS_BUDGET_MS (60 s; 3 s between attempts, 5 s per request). An
 * exhausted budget reds the run with a `readiness:` message before a single
 * question is asked — nothing sampled, skipped, or spent. A `/v1/chat` round-trip
 * that ends without a response — a failed connection, or a 502/503/504 edge
 * rejection — is readiness on ANY question, because no answer exists to judge and
 * nothing was spent. It is retried with exponential backoff (2 s, 4 s, 8 s) out of
 * one per-run budget of three retries; when that is spent the verdict is a
 * `readiness:` failure naming the question and the last cause, not a skip. A
 * request whose response headers arrived and whose stream then broke is
 * answered-then-failed: a real failure, never retried. So is any 4xx or 500. A skip
 * therefore means a question could not be measured — a readiness failure with its
 * retries spent, or a real failure after the target answered — never "the smoke
 * sampled a restart window and moved on".
 *
 * A live run needs staging secrets (the VPS store URL + vendor keys); absent them
 * the script fails fast with the missing name. Run instructions: SPECS §3.7.
 *
 * The config load, budget banner, fixture load, summary printer and exit policy are
 * the shared CLI glue in `eval-cli.mjs`; this script keeps only the subset selection
 * and the readiness gate's wiring.
 */
import * as evalpkg from "@app/eval";
// The required coverage classes and the held-out cases are the domain pack's
// vocabulary, imported so a rename cannot strand the gate.
import { SMOKE_COVERAGE_TAGS, SMOKE_HELD_OUT_IDS } from "@app/kajianq-domain";
import { createStagingHarness } from "./staging-harness.mjs";
import { createChatReadinessGate, waitForReadiness } from "./readiness.mjs";
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

// Readiness before the sample: the deploy restarts the API and makes a single health
// request, so the seconds after it are when a proxy still answers 502. Asking the
// sample now would count that window as skips; waiting it out first keeps a skip
// meaning "the API went down mid-run". This runs before the store bootstrap, so a
// target that never becomes ready costs neither a ledger row nor a question.
try {
  await waitForReadiness({ baseUrl: config.apiBaseUrl });
} catch (err) {
  fail("eval:smoke", err instanceof Error ? err.message : String(err));
}

// The staging bootstrap (store, sourceType scan, transport, traces, ledger, refusal
// markers) is shared with eval:run — one copy, no drift.
const harness = await createStagingHarness(config, budget);

// Every question gets the readiness classification: a no-response round-trip is
// retried out of one per-run budget and, if that is spent, reported as readiness
// rather than swallowed as a skip. A broken stream or an app error passes straight
// through as the real failure it is.
const gate = createChatReadinessGate(harness.transport);

const label = config.runLabel ?? `${fixture.id}-smoke`;
const result = await evalpkg.runGoldenSet(selection.set, {
  transport: gate.transport,
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

// A run whose readiness retries are spent ends on the gate's failure, and the
// verdict says so — the skip rows above are the harness's record of a run that could
// not finish, not a measured outage. Printed after the summary so the evidence block
// keeps both.
const readinessFailure = gate.readinessFailure();
if (readinessFailure !== undefined) fail("eval:smoke", readinessFailure.message);

// The shared policy: a skip fails the gate exactly as a failure does, and so does a
// question the budget cap left unmeasured. `questionCount` is the subset actually
// asked — not the fixture's full count, which would read as truncated.
exitWithPolicy("eval:smoke", {
  runId: result.runId,
  questionCount: selection.set.questions.length,
  result,
});
