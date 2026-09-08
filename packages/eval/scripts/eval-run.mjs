#!/usr/bin/env bun
/**
 * eval-run.mjs — the `eval:run` Golden Set CLI (issue #8).
 *
 *   bun run eval:run
 *
 * Env:
 *   EVAL_API_BASE_URL      the staging /v1/chat origin (required)
 *   EVAL_API_TOKEN         an anonymous Bearer token minted by the API (required)
 *   NEON_DATABASE_URL      the staging Neon store to read answer traces from
 *                          and persist eval_runs/eval_results into (required)
 *   EVAL_BUDGET_MICRO_USD  hard spend cap in micro-USD; the run aborts when
 *                          the cap is hit (harness LLM calls + the pipeline
 *                          costs recorded in each answer trace)
 *   EVAL_RUN_LABEL         optional run label (defaults to the fixture id)
 *
 * Thin composition root (B5): loads the Golden Set fixture from the domain
 * pack, wires the SSE client + the Neon store through the @app/eval seams,
 * runs the harness, and prints the summary. Missing API keys are reported
 * NOT RUN (same posture as provider-smoke): the harness aborts because it
 * needs the staging API to be serving.
 */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { Effect } from "effect";
import * as app from "@app/infra";
import * as evalpkg from "@app/eval";

function fail(msg) {
  console.error(`eval:run: ${msg}`);
  process.exit(1);
}

const baseUrl = process.env.EVAL_API_BASE_URL;
const token = process.env.EVAL_API_TOKEN;
const neonUrl = process.env.NEON_DATABASE_URL;
if (!baseUrl) fail("EVAL_API_BASE_URL is not set");
if (!token) fail("EVAL_API_TOKEN is not set");
if (!neonUrl) fail("NEON_DATABASE_URL is not set");

// Budget: the hard cap from env (plan decision 4). Parsing is strict.
let cap;
try {
  cap = evalpkg.budgetCapFromEnv(process.env.EVAL_BUDGET_MICRO_USD);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
const budget = new evalpkg.Budget(cap);
console.log(
  `eval:run: budget ${cap === undefined ? "uncapped" : `${cap} micro-USD`} (EVAL_BUDGET_MICRO_USD)`,
);

// The Golden Set fixture — validated against the contract, then against the
// v0 content bar (the trap-tag label is the domain's vocabulary).
const fixturePath = new URL("../../kajianq-domain/fixtures/golden-set-v0.json", import.meta.url);
const fixture = evalpkg.loadGoldenSetJson(readFileSync(fixturePath, "utf8"), "golden-set-v0.json");
try {
  evalpkg.assertV0Shape(fixture, { trapTag: "dhaif-trap" });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
console.log(
  `eval:run: golden set "${fixture.id}" — ${fixture.questions.length} questions, status ${fixture.status}`,
);

// Seams: the staging Neon store answers trace reads + the eval ledger.
const sql = neon(neonUrl);
const store = app.createRagStore("neon", sql);
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
    if (budget.wouldExceed()) throw new evalpkg.BudgetExceededError(cap ?? 0, budget.total);
    const reply = await evalpkg.postChatSse({
      baseUrl,
      token,
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

const ledger = {
  async createRun(label, report) {
    report.runId = "";
    const id = await runStore(store.insertEvalRun({ label, report }));
    report.runId = id;
    // Refresh the row so the stored report carries its own run id.
    await runStore(store.insertEvalRun({ id, label, report }));
    return id;
  },
  async saveResult(runId, questionId, outcome, traceId) {
    return runStore(
      store.insertEvalResult({
        runId,
        questionId,
        answerTraceId: traceId,
        outcome,
      }),
    );
  },
};

// The per-result rows need the run id before the report exists, so run the
// harness loop here (the harness's runGoldenSet is single-shot; the CLI keeps
// the per-question sequencing to thread runId into saveResult).
const harnessResult = await (async () => {
  const results = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let budgetExceeded = false;
  const startedAt = Date.now();

  const runId = await runStore(
    store.insertEvalRun({
      label: process.env.EVAL_RUN_LABEL ?? fixture.id,
      report: { pending: true },
    }),
  );

  for (const question of fixture.questions) {
    if (budget.wouldExceed()) {
      budgetExceeded = true;
      console.warn(`eval:run: budget cap hit before question ${question.id} — aborting`);
      break;
    }
    try {
      const reply = await transport.ask(question);
      const events = reply.messageId ? ((await traces.eventsByMessage(reply.messageId)) ?? []) : [];
      const outcome = evalpkg.scoreQuestion(question, reply.text, events, {
        sourceTypeOf: (id) => sourceTypeByChunkId.get(id),
        refusalMarkers: REFUSAL_MARKERS,
      });
      await ledger.saveResult(runId, question.id, outcome, reply.traceId);
      results.push({ ...outcome, traceId: reply.traceId });
      if (outcome.passed) passed += 1;
      else failed += 1;
      console.log(
        `  ${question.id}  ${outcome.passed ? "PASS" : "FAIL"}  recall=${outcome.retrievalRecall.toFixed(2)} citations=${outcome.citationValidity.toFixed(2)}${outcome.refused ? " refused" : ""}`,
      );
    } catch (err) {
      if (err instanceof evalpkg.BudgetExceededError) {
        budgetExceeded = true;
        console.warn(`eval:run: ${err.message}`);
        break;
      }
      skipped += 1;
      results.push({
        questionId: question.id,
        expectedBehavior: question.expectedBehavior,
        passed: false,
        retrievalRecall: 0,
        citationValidity: 0,
        refused: false,
        notes: [`skipped: ${err instanceof Error ? err.message : String(err)}`],
      });
      console.warn(`  ${question.id}  SKIPPED  ${err instanceof Error ? err.message : err}`);
    }
  }

  const scored = results.filter((r) => !r.notes?.some((n) => n.startsWith("skipped:")));
  const report = evalpkg.buildReport(fixture, {
    runId,
    startedAt,
    finishedAt: Date.now(),
    results,
    passed,
    failed,
    skipped,
    budgetExceeded,
    scored,
  });
  report.costMicroUsd = budget.total;
  // Persist the final report (idempotent by run id) and read back the ledger.
  await ledger.createRun(runId, report);
  return { runId, report, passed, failed, skipped, budgetExceeded, results };
})();

const r = harnessResult;
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const scored = r.results.filter((x) => !x.notes?.some((n) => n.startsWith("skipped:")));
console.log(
  [
    "",
    `eval:run summary — run ${r.runId}`,
    `  questions: ${fixture.questions.length}  passed: ${r.passed}  failed: ${r.failed}  skipped: ${r.skipped}`,
    `  mean retrieval recall: ${mean(scored.map((x) => x.retrievalRecall))?.toFixed(3) ?? "n/a"}`,
    `  mean citation validity: ${mean(scored.map((x) => x.citationValidity))?.toFixed(3) ?? "n/a"}`,
    `  cost: ${(r.report.costMicroUsd / 1e6).toFixed(6)} USD  budget exceeded: ${r.budgetExceeded}`,
  ].join("\n"),
);
