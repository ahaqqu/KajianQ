#!/usr/bin/env bun
/**
 * staging-harness.mjs — the shared staging bootstrap for the eval CLIs
 * (thermo-review B2).
 *
 * `eval:run` and `eval:smoke` used to carry near-identical copies of this
 * setup — the Postgres store, the `doc_children` sourceType join, the ledger
 * and trace bridges, and the refusal markers. Two copies of the same staging
 * wiring drift: one entry point's fix silently misses the other. Both scripts
 * now build their seams from this one module.
 *
 * Why a script module and not `@app/eval/src`: the eval package is an engine
 * package, and the boundary gate (ADR-0005/0008) forbids a direct database
 * client there. The database client belongs behind @app/infra — these
 * scripts, where `eval:run`'s store wiring has always lived.
 *
 * The refusal markers are imported from the domain pack's own
 * `DEFAULT_REFUSALS`, so the scripts, the pipeline, and the scorer cannot
 * disagree about what counts as a refusal — the previous two literal copies
 * could.
 */
import { Effect } from "effect";
import { createLogger, resolvePostgresStore } from "@app/infra";
import { BudgetExceededError, postChatSse } from "@app/eval";
import {
  DEFAULT_REFUSALS,
  citationCandidatesIn,
  normalizeCitationLabel,
} from "@app/kajianq-domain";

/** The generator's refusal text in each answer language (domain-owned). */
export const REFUSAL_MARKERS = [DEFAULT_REFUSALS.id, DEFAULT_REFUSALS.en];

/**
 * The citation grammar the scorer normalizes labels with (C2 fix). It is the
 * DOMAIN's own functions — the same ones the deterministic citation gate
 * (`validateCitations`) and the citations-frame derivation use — injected here
 * by the composition root, so the engine package stays domain-agnostic while
 * the scorer and the gate cannot disagree about what a citation is.
 */
export const CITATION_GRAMMAR = {
  normalizeLabel: normalizeCitationLabel,
  labelsInText: citationCandidatesIn,
};

/**
 * Build the staging seams one eval run needs. The store is resolved from the
 * connection URL through `@app/infra`'s own composition helper — the script
 * never imports a database client (ADR-0008), it names the URL and receives
 * the seam — and every seam is bound to that store, so a script supplies only
 * its question set and its summary. The logger is passed into the store so the
 * adapter's slow-query/error logging stays visible in an eval run, exactly as
 * it is in a serving run.
 */
export async function createStagingHarness(config, budget) {
  const store = resolvePostgresStore(config.databaseUrl, {
    logger: createLogger({ service: "eval", route: "staging-harness" }),
  });
  const runStore = (effect) => Effect.runPromise(effect);

  // Chunk-id → sourceType resolver for retrieval recall: the trace's retrieval
  // events carry only chunk ids (ADR-0007), and the source-type labels live in
  // the chunks' metadata, so the join is this harness's job. It goes through
  // the store's own `getDocChildrenByIds` seam read — the ids a trace names are
  // exactly the rows that read exists for — resolved lazily per retrieval and
  // memoized, so a long run does not re-read the same chunk row.
  const sourceTypeByChunkId = new Map();
  const sourceTypeOf = (id) => sourceTypeByChunkId.get(id);
  const loadSourceTypes = async (chunkIds) => {
    const missing = [...new Set(chunkIds)].filter((id) => !sourceTypeByChunkId.has(id));
    if (missing.length === 0) return;
    // The store seam is effect-shaped: without the await this iterates the
    // PROMISE — "{} is not iterable" — and the question skips. Lost in the
    // GDPR-E rewire; the CI gate could not catch it because the self-skip
    // reads as a transport failure.
    const rows = await runStore(store.getDocChildrenByIds(missing));
    for (const row of rows) {
      const meta = row.metadata ?? {};
      if (typeof meta.sourceType === "string") sourceTypeByChunkId.set(row.id, meta.sourceType);
      // Cache the miss too: a chunk without a sourceType label must not be
      // re-queried by every later question that retrieves it.
      else sourceTypeByChunkId.set(row.id, undefined);
    }
  };

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
      // The structured citations frame (ADR-0040) rides along: the scorer
      // prefers its labels, which the server grounded against the persisted
      // trace, over re-parsing the answer text.
      return {
        text: reply.text,
        messageId: reply.messageId,
        traceId: reply.traceId,
        citations: reply.citations,
      };
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
      // Warm the sourceType cache from the retrieval events this trace carries,
      // before the scorer reads the (synchronous) resolver.
      for (const event of trace.events) {
        if (event.kind === "retrieval") {
          await loadSourceTypes((event.detail?.chunks ?? []).map((ref) => ref.id));
        }
      }
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
    sourceTypeOf,
    transport,
    traces,
    ledger,
    refusalMarkers: REFUSAL_MARKERS,
    citationGrammar: CITATION_GRAMMAR,
  };
}
