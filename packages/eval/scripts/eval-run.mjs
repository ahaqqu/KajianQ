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
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { neon } from "@neondatabase/serverless";
import * as app from "@app/infra";
import * as evalpkg from "@app/eval";
import { loadEvalRunConfig } from "./eval-config.ts";

function fail(msg) {
  console.error(`eval:run: ${msg}`);
  process.exit(1);
}

// B2: the one validated, typed config seam — no ad hoc process.env reads.
const config = (() => {
  try {
    return loadEvalRunConfig(process.env);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
})();

const budget = new evalpkg.Budget(config.budgetCapMicroUsd);
console.log(
  `eval:run: budget ${config.budgetCapMicroUsd === undefined ? "uncapped" : `${config.budgetCapMicroUsd} micro-USD`} (EVAL_BUDGET_MICRO_USD)`,
);

// The Golden Set fixture — validated against the contract, then against the
// v0 content bar (the trap-tag label is the domain's vocabulary). A2: the
// path comes from the validated config (EVAL_GOLDEN_SET_PATH), not a
// hard-coded cross-package URL.
const fixturePath = resolve(process.cwd(), config.goldenSetPath);
let fixture;
try {
  fixture = evalpkg.loadGoldenSetJson(readFileSync(fixturePath, "utf8"), "golden-set-v0.json");
  evalpkg.assertV0Shape(fixture, { trapTag: "dhaif-trap" });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
console.log(
  `eval:run: golden set "${fixture.id}" — ${fixture.questions.length} questions, status ${fixture.status}`,
);

// Seams: the staging Neon store answers trace reads + the eval ledger.
const sql = neon(config.neonDatabaseUrl);
const store = app.createNeonRagStore(sql);
const runStore = (effect) => Effect.runPromise(effect);

// Chunk-id → sourceType resolver for retrieval recall: the trace's retrieval
// events carry chunk ids (ADR-0007); the source-type labels live in the
// chunks' metadata, loaded once here.
const sourceTypeByChunkId = new Map();
{
  const rows = await sql`SELECT id, metadata FROM doc_children WHERE metadata ? 'sourceType'`;
  for (const row of rows) {
    const meta = row.metadata ?? {};
    if (typeof meta.sourceType === "string") sourceTypeByChunkId.set(row.id, meta.sourceType);
  }
}

// Refusal markers: the generator's ID/EN insufficiency language (the domain
// pack's grounding prompts). A trace `refusal` event also detects.
const REFUSAL_MARKERS = ["tidak menemukan dalil yang memadai", "could not find adequate evidence"];

const transport = {
  async ask(question) {
    if (budget.wouldExceed()) throw new evalpkg.BudgetExceededError(config.budgetCapMicroUsd ?? 0, budget.total);
    const reply = await evalpkg.postChatSse({
      baseUrl: config.apiBaseUrl,
      token: config.apiToken,
      question: question.question,
      language: question.language === "en" ? "en" : "id",
    });
    return { text: reply.text, messageId: reply.messageId, traceId: reply.traceId };
  },
};

const traces = {
  async eventsByMessage(messageId) {
    const trace = await runStore(store.getAnswerTraceByMessage(messageId));
    if (!trace) return null;
    // Budget coverage (plan decision 4): the answer trace's event costs are
    // the pipeline spend the harness triggered — count them into the cap.
    budget.add(trace.events.reduce((s, e) => s + (e.cost?.costMicroUsd ?? 0), 0));
    budget.check();
    return trace.events;
  },
};

// A9: the ledger adapter is a thin passthrough — the harness owns the run
// lifecycle (createRun first, refreshRun for the final report), so no
// report mutation and no double write here.
const ledger = {
  async createRun(label, report) {
    return runStore(store.insertEvalRun({ label, report }));
  },
  async refreshRun(runId, label, report) {
    await runStore(store.insertEvalRun({ id: runId, label, report }));
  },
  async saveResult(runId, questionId, outcome, traceId) {
    return runStore(store.insertEvalResult({ runId, questionId, answerTraceId: traceId, outcome }));
  },
};

const harnessResult = await evalpkg.runGoldenSet(fixture, {
  transport,
  traces,
  ledger,
  sourceTypeOf: (id) => sourceTypeByChunkId.get(id),
  refusalMarkers: REFUSAL_MARKERS,
  ...(config.runLabel !== undefined ? { label: config.runLabel } : {}),
  budget,
});

const r = harnessResult;
const report = await runStore(store.getEvalRun(r.runId));
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const scored = r.results.filter((x) => x.skipped !== true);
console.log(
  [
    "",
    `eval:run summary — run ${r.runId}`,
    `  questions: ${fixture.questions.length}  passed: ${r.passed}  failed: ${r.failed}  skipped: ${r.skipped}`,
    `  mean retrieval recall: ${mean(scored.map((x) => x.retrievalRecall))?.toFixed(3) ?? "n/a"}`,
    `  mean citation validity: ${mean(scored.map((x) => x.citationValidity))?.toFixed(3) ?? "n/a"}`,
    `  cost: ${((report?.costMicroUsd ?? budget.total) / 1e6).toFixed(6)} USD  budget exceeded: ${r.budgetExceeded}`,
  ].join("\n"),
);
