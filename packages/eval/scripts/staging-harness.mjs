#!/usr/bin/env bun
/**
 * staging-harness.mjs — the shared staging bootstrap for the eval CLIs.
 *
 * `eval:run` and `eval:smoke` build the same staging seams — the Postgres
 * store, the `doc_children` chunk-metadata join, the ledger and trace bridges, and
 * the refusal markers — so they share one module: a copy per entry point
 * drifts, and one entry point's fix then silently misses the other.
 *
 * Why a script module and not `@app/eval/src`: the eval package is an engine
 * package, and the boundary gate (ADR-0005/0008) forbids a direct database
 * client there. The database client belongs behind @app/infra — these
 * scripts supply the store wiring.
 *
 * The refusal markers are imported from the domain pack's own
 * `DEFAULT_REFUSALS`, so the scripts, the pipeline, and the scorer cannot
 * disagree about what counts as a refusal.
 */
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { createLogger, resolvePostgresStore } from "@app/infra";
import { BudgetExceededError, postChatSse } from "@app/eval";
import {
  CITATION_LOOKUP_ORIGIN,
  DEFAULT_REFUSALS,
  QUOTE_EQUIVALENCES,
  SCOPE_EXPANSION_ORIGIN,
  addressesNamedBy,
  citationCandidatesIn,
  identityResolver,
  normalizeCitationLabel,
  parseHadithIdentitySet,
} from "@app/kajianq-domain";

/** The generator's refusal text in each answer language (domain-owned). */
export const REFUSAL_MARKERS = [DEFAULT_REFUSALS.id, DEFAULT_REFUSALS.en];

/**
 * The opaque `origin` label the domain pack writes on scope-expansion chunks
 * (ADR-0045), injected into the harness so each scored outcome records what
 * the expansion contributed. Domain vocabulary, so it is named HERE, at
 * the composition root — the engine package only compares opaque labels.
 */
export const EXPANSION_ORIGIN = SCOPE_EXPANSION_ORIGIN;

/**
 * The opaque `origin` label the domain pack writes on citation-label lookup
 * chunks (ADR-0058), injected beside the scope label for the same reason: the
 * harness compares it and never names it, and the provenance block can then
 * report a label-only question's lookup contribution.
 */
export const LOOKUP_ORIGIN = CITATION_LOOKUP_ORIGIN;

/**
 * The citation grammar the scorer normalizes labels with. It is the
 * DOMAIN's own functions — the same ones the deterministic citation gate
 * (`validateCitations`) and the citations-frame derivation use — injected here
 * by the composition root, so the engine package stays domain-agnostic while
 * the scorer and the gate cannot disagree about what a citation is.
 *
 * `addressesNamedBy` is the naming declaration the scorer compares a required
 * citation against the answer's evidence with: the question requires
 * `QS. 2:255`, the answer cites the grounded range `QS. 2:255-256`, and the
 * two are the same evidence once the range's addresses are read from the
 * grammar that declares them. The engine learns no domain vocabulary — it
 * asks the injected grammar what a label names.
 */
export const CITATION_GRAMMAR = {
  normalizeLabel: normalizeCitationLabel,
  labelsInText: citationCandidatesIn,
  addressesNamedBy,
};

/**
 * The Matn identity resolver the scorer compares citations with.
 * The map is the DOMAIN's curated, owner-signed data (`hadith-identities-v0`);
 * the composition root loads it here and hands the engine an opaque resolver,
 * so the engine learns no hadith vocabulary and cannot drift from the map. A
 * label the map does not carry resolves to `null`, which keeps the scorer on
 * its exact-label comparison — an unmapped or fabricated citation can satisfy
 * only the identical required label, never another.
 */
const HADITH_IDENTITY_FIXTURE = new URL(
  "../../kajianq-domain/fixtures/hadith-identities-v0.json",
  import.meta.url,
);

export const CITATION_IDENTITY = {
  identityOf: identityResolver(
    parseHadithIdentitySet(
      JSON.parse(readFileSync(HADITH_IDENTITY_FIXTURE, "utf8")),
      "hadith-identities-v0",
    ),
  ),
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

  // Chunk-id → metadata resolvers for the two retrieval metrics: the trace's
  // retrieval events carry only chunk ids (ADR-0007), and the labels live in
  // the chunks' metadata, so the join is this harness's job. It goes through
  // the store's own `getDocChildrenByIds` seam read — the ids a trace names are
  // exactly the rows that read exists for — resolved lazily per retrieval and
  // memoized, so a long run does not re-read the same chunk row. `sourceType`
  // answers source-type recall; `citation` answers citation-address recall.
  const sourceTypeByChunkId = new Map();
  const citationByChunkId = new Map();
  const sourceTypeOf = (id) => sourceTypeByChunkId.get(id);
  const citationOf = (id) => citationByChunkId.get(id);
  const loadChunkMetadata = async (chunkIds) => {
    const missing = [...new Set(chunkIds)].filter((id) => !sourceTypeByChunkId.has(id));
    if (missing.length === 0) return;
    // The store seam is effect-shaped: without the await this iterates the
    // PROMISE — "{} is not iterable" — and the question skips.
    const rows = await runStore(store.getDocChildrenByIds(missing));
    for (const row of rows) {
      const meta = row.metadata ?? {};
      if (typeof meta.sourceType === "string") sourceTypeByChunkId.set(row.id, meta.sourceType);
      // Cache the miss too: a chunk without a sourceType label must not be
      // re-queried by every later question that retrieves it.
      else sourceTypeByChunkId.set(row.id, undefined);
      if (typeof meta.citation === "string") citationByChunkId.set(row.id, meta.citation);
      else citationByChunkId.set(row.id, undefined);
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
      // Budget coverage: the answer trace's event costs are the pipeline spend
      // the harness triggered — count them into the cap.
      budget.add(trace.events.reduce((s, e) => s + (e.cost?.costMicroUsd ?? 0), 0));
      budget.check();
      // Warm both metadata caches from the retrieval events this trace carries,
      // before the scorer reads the (synchronous) resolvers.
      for (const event of trace.events) {
        if (event.kind === "retrieval") {
          await loadChunkMetadata((event.detail?.chunks ?? []).map((ref) => ref.id));
        }
      }
      return trace.events;
    },
  };

  // The ledger adapter is a thin passthrough — the harness owns the run
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
    citationByChunkId,
    sourceTypeOf,
    citationOf,
    transport,
    traces,
    ledger,
    refusalMarkers: REFUSAL_MARKERS,
    citationGrammar: CITATION_GRAMMAR,
    citationIdentity: CITATION_IDENTITY,
    expansionOrigin: EXPANSION_ORIGIN,
    lookupOrigin: LOOKUP_ORIGIN,
    // The language's own quote-normalisation equivalences, owned by the domain pack
    // (`QUOTE_EQUIVALENCES`) and injected here so the engine's fold stays generic.
    quoteEquivalences: QUOTE_EQUIVALENCES,
  };
}
