import { Effect } from "effect";
import { neon } from "@neondatabase/serverless";
import { createNeonRagStore } from "@app/infra";
import { Budget, BudgetExceededError } from "./budget";
import type { ChatTransport, RunLedger, AnswerTraceSource } from "./harness";
import type { TraceEventLike } from "./harness-types";
import type { EvalRunConfig } from "./eval-config";
import { postChatSse } from "./api-client";

/**
 * The shared staging bootstrap for the eval CLIs (thermo-review B2).
 *
 * `eval:run` and `eval:smoke` used to carry near-identical copies of this
 * setup — the Neon store, the `doc_children` sourceType scan, the ledger and
 * trace bridges, and the refusal markers. Two copies of the same staging
 * wiring drift: one entry point's fix silently misses the other. Both scripts
 * now build their harness from this one function.
 *
 * The refusal markers live here rather than as literals in each script so the
 * scripts and the scorer cannot disagree about what counts as a refusal. They
 * are the domain pack's grounding-insufficiency language (`DEFAULT_REFUSALS`
 * in `@app/kajianq-domain`); the engine cannot import them from there without
 * violating engine purity, so the caller supplies the text and this constant
 * is the CLI layer's single copy.
 */

/** The generator's refusal text in each answer language (CLI-side copy). */
export const REFUSAL_MARKERS: readonly string[] = [
  "tidak menemukan dalil yang memadai",
  "could not find adequate evidence",
];

/** The staging seams one eval run needs, plus the store that backs them. */
export type StagingHarness = {
  /** The RagStore the trace reads and ledger writes go through. */
  store: ReturnType<typeof createNeonRagStore>;
  /** Runs one store Effect to a promise (the CLI's single bridge). */
  runStore: <A>(effect: unknown) => Promise<A>;
  /** Chunk-id → sourceType, scanned once from `doc_children`. */
  sourceTypeByChunkId: Map<string, string>;
  /** Chunk-id → sourceType resolver for the harness. */
  sourceTypeOf: (chunkId: string) => string | undefined;
  /** The `/v1/chat` transport, budget-guarded. */
  transport: ChatTransport;
  /** Answer-trace reads (their costs are counted into the budget). */
  traces: AnswerTraceSource;
  /** The eval ledger writes. */
  ledger: RunLedger;
  /** Refusal markers for the scorer. */
  refusalMarkers: readonly string[];
};

/** The trace shape the store returns (structurally the contracts `Trace`). */
type StoredTrace = { events: readonly TraceEventLike[] } | null;

/**
 * Build the staging harness from the validated run config. The Neon client is
 * constructed here (the one place the eval CLIs touch the driver) and every
 * seam is bound to the store, so a script only supplies its question set and
 * its summary.
 */
export async function createStagingHarness(
  config: EvalRunConfig,
  budget: Budget,
): Promise<StagingHarness> {
  const sql = neon(config.neonDatabaseUrl);
  const store = createNeonRagStore(sql);
  const runStore = <A>(effect: unknown): Promise<A> =>
    Effect.runPromise(effect as never) as Promise<A>;

  // Chunk-id → sourceType resolver for retrieval recall: the trace's retrieval
  // events carry chunk ids (ADR-0007); the source-type labels live in the
  // chunks' metadata, loaded once here.
  const sourceTypeByChunkId = new Map<string, string>();
  {
    const rows = (await sql`SELECT id, metadata FROM doc_children WHERE metadata ? 'sourceType'`) as {
      id: string;
      metadata?: { sourceType?: unknown } | null;
    }[];
    for (const row of rows) {
      const meta = row.metadata ?? {};
      if (typeof meta.sourceType === "string") sourceTypeByChunkId.set(row.id, meta.sourceType);
    }
  }

  const transport: ChatTransport = {
    async ask(question) {
      if (budget.wouldExceed()) {
        throw new BudgetExceededError(config.budgetCapMicroUsd ?? 0, budget.total);
      }
      const reply = await postChatSse({
        baseUrl: config.apiBaseUrl,
        token: config.apiToken,
        question: question.question,
        language: question.language === "en" ? "en" : "id",
      });
      return { text: reply.text, messageId: reply.messageId, traceId: reply.traceId };
    },
  };

  const traces: AnswerTraceSource = {
    async eventsByMessage(messageId) {
      const trace = await runStore<StoredTrace>(store.getAnswerTraceByMessage(messageId));
      if (!trace) return null;
      // Budget coverage: the answer trace's event costs are the pipeline spend
      // the harness triggered — count them into the cap.
      budget.add(
        trace.events.reduce((sum, event) => sum + (event.cost?.costMicroUsd ?? 0), 0),
      );
      budget.check();
      return trace.events;
    },
  };

  // The harness's ledger seam types the report as `unknown` (it is agnostic to
  // the report's shape); the store's contract types it as the contracts report
  // union. The two are the same value by construction — the harness builds the
  // report and this adapter only forwards it — so the narrow cast at this one
  // boundary is where the two vocabularies meet.
  const ledgerReport = (report: unknown): Parameters<typeof store.insertEvalRun>[0]["report"] =>
    report as Parameters<typeof store.insertEvalRun>[0]["report"];

  const ledger: RunLedger = {
    async createRun(label, report) {
      return runStore<string>(store.insertEvalRun({ label, report: ledgerReport(report) }));
    },
    async refreshRun(runId, label, report) {
      await runStore(store.insertEvalRun({ id: runId, label, report: ledgerReport(report) }));
    },
    async saveResult(runId, questionId, outcome, traceId) {
      return runStore<string>(
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
