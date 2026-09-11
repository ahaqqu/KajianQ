#!/usr/bin/env bun
/**
 * staging-harness.mjs — the shared staging bootstrap for the eval CLIs
 * (thermo-review B2).
 *
 * `eval:run` and `eval:smoke` used to carry near-identical copies of this
 * setup — the Neon store, the `doc_children` sourceType scan, the ledger and
 * trace bridges, and the refusal markers. Two copies of the same staging
 * wiring drift: one entry point's fix silently misses the other. Both scripts
 * now build their seams from this one module.
 *
 * Why a script module and not `@app/eval/src`: the eval package is an engine
 * package, and the boundary gate (ADR-0005/0008) forbids a direct database
 * client there. The Neon driver belongs to the CLI composition root — these
 * scripts, where `eval:run`'s store wiring has always lived.
 *
 * The refusal markers are imported from the domain pack's own
 * `DEFAULT_REFUSALS`, so the scripts, the pipeline, and the scorer cannot
 * disagree about what counts as a refusal — the previous two literal copies
 * could.
 */
import { Effect } from "effect";
import { neon } from "@neondatabase/serverless";
import { createNeonRagStore } from "@app/infra";
import { BudgetExceededError, postChatSse } from "@app/eval";
import { DEFAULT_REFUSALS } from "@app/kajianq-domain";

/** The generator's refusal text in each answer language (domain-owned). */
export const REFUSAL_MARKERS = [DEFAULT_REFUSALS.id, DEFAULT_REFUSALS.en];

/**
 * Build the staging seams one eval run needs. The Neon client is constructed
 * here and every seam is bound to the store, so a script supplies only its
 * question set and its summary.
 */
export async function createStagingHarness(config, budget) {
  const sql = neon(config.neonDatabaseUrl);
  const store = createNeonRagStore(sql);
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

  const transport = {
    async ask(question) {
      if (budget.wouldExceed())
        throw new BudgetExceededError(config.budgetCapMicroUsd ?? 0, budget.total);
      const reply = await postChatSse({
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
      return runStore(
        store.insertEvalResult({ runId, questionId, answerTraceId: traceId, outcome }),
      );
    },
  };

  return {
    store,
    runStore,
    sourceTypeByChunkId,
    sourceTypeOf: (id) => sourceTypeByChunkId.get(id),
    transport,
    traces,
    ledger,
    refusalMarkers: REFUSAL_MARKERS,
  };
}
