import type { EvalResultOutcome, EvalRunReport, GoldenQuestion, GoldenSet } from "@app/contracts";
import { Budget, BudgetExceededError } from "./budget";
import { citationValidity, detectRefusal, refusalCorrectness, retrievalRecall } from "./scorers";
import type { CostRecordLike, TraceEventLike } from "./harness-types";

/**
 * EvalHarness (#8): run a Golden Set against a chat target, score each
 * question deterministically, persist per-run results, and cap cost.
 *
 * The harness is transport-agnostic: the caller supplies a `ChatTransport`
 (the SSE client implements it) and a `RunLedger` (the RagStore adapter
 * implements it). Scoring reads the answer trace the API persisted —
 * retrieval recall comes from the trace's `retrieval` events (plan decision
 * 3), never from client-side guesses.
 */

export type ChatTransportResult = {
  text: string;
  messageId: string | null;
  traceId: string | null;
};

/** One question's round-trip against the target. */
export interface ChatTransport {
  ask(question: GoldenQuestion): Promise<ChatTransportResult>;
}

/** Fetch one answer's trace events by message id (the store adapter bridges). */
export interface AnswerTraceSource {
  eventsByMessage(messageId: string): Promise<readonly TraceEventLike[] | null>;
}

/**
 * The eval-ledger persistence role (the RagStore adapter bridges). The
 * harness owns the run lifecycle: `createRun` first (thermo-review A3/A4 —
 * the pre-fix loop saved per-question rows with a blank run id the store's
 * `::uuid` cast rejects, and persisted the report with an id no caller ever
 * stamped back), `saveResult` per question, `refreshRun` to store the final
 * report against the run id in a single idempotent write (no CLI
 * double-write, A9).
 */
export interface RunLedger {
  createRun(label: string, report: unknown): Promise<string>;
  /** Idempotent upsert of the final report row (by run id). */
  refreshRun(runId: string, label: string, report: unknown): Promise<void>;
  saveResult(
    runId: string,
    questionId: string,
    outcome: EvalResultOutcome,
    traceId: string | null,
  ): Promise<string>;
}

export type HarnessDeps = {
  transport: ChatTransport;
  traces: AnswerTraceSource;
  ledger: RunLedger;
  /** Chunk-id → source-type resolver (from the store or fixture metadata). */
  sourceTypeOf: (chunkId: string) => string | undefined;
  budget: Budget;
  /** Refusal markers in the answer text (domain vocabulary, caller-supplied). */
  refusalMarkers?: readonly string[];
  /** Run label persisted with the report. */
  label?: string;
  now?: () => number;
};

export type HarnessQuestionResult = EvalResultOutcome & { traceId: string | null };

export type HarnessRunResult = {
  runId: string;
  passed: number;
  failed: number;
  skipped: number;
  budgetExceeded: boolean;
  results: HarnessQuestionResult[];
};

/**
 * Run the whole set. The run is created FIRST so every `saveResult` and the
 * persisted report carry the real run id (A3/A4) and the caller needs no
 * post-hoc stamping (A9). Per question: ask → read trace → score → persist
 * → check budget. A transport failure marks the question skipped and keeps
 * the run going; a budget hit aborts the remaining questions (plan
 * decision 4).
 */
export async function runGoldenSet(set: GoldenSet, deps: HarnessDeps): Promise<HarnessRunResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const runId = await deps.ledger.createRun(deps.label ?? set.id, { pending: true });
  const results: HarnessQuestionResult[] = [];
  const costs: CostRecordLike[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let budgetExceeded = false;

  for (const question of set.questions) {
    if (deps.budget.wouldExceed()) {
      budgetExceeded = true;
      break;
    }
    try {
      const reply = await deps.transport.ask(question);
      const events = reply.messageId
        ? ((await deps.traces.eventsByMessage(reply.messageId)) ?? [])
        : [];
      // Thermo-review B1: the trace's cost records feed the report directly —
      // the budget accumulator already counted them (single accumulator,
      // ADR-0034 decision 2); the report must not discard them.
      for (const event of events) {
        if (event.cost) costs.push(event.cost);
      }
      const outcome = scoreQuestion(question, reply.text, events, deps);
      results.push({ ...outcome, traceId: reply.traceId });
      if (outcome.passed) passed += 1;
      else failed += 1;
      await deps.ledger.saveResult(runId, question.id, outcome, reply.traceId);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        budgetExceeded = true;
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
        skipped: true,
        notes: [`skipped: ${err instanceof Error ? err.message : String(err)}`],
        traceId: null,
      });
    }
  }

  // Thermo-review C1: skipped questions are flagged explicitly and excluded
  // from the scored means — never via the brittle notes-prefix heuristic.
  const scored = results.filter((r) => r.skipped !== true);
  const report = buildReport(set, {
    runId,
    startedAt,
    finishedAt: now(),
    results,
    passed,
    failed,
    skipped,
    budgetExceeded,
    scored,
    costMicroUsd: deps.budget.total,
    costs,
  });
  await deps.ledger.refreshRun(runId, deps.label ?? set.id, report);
  return { runId, passed, failed, skipped, budgetExceeded, results };
}

/** Score one question from its answer text and trace events. */
export function scoreQuestion(
  question: GoldenQuestion,
  answerText: string,
  events: readonly TraceEventLike[],
  deps: Pick<HarnessDeps, "sourceTypeOf" | "refusalMarkers">,
): EvalResultOutcome {
  const retrieval = events.filter((e) => e.kind === "retrieval").at(-1);
  const chunks = retrieval?.detail?.chunks ?? [];
  const recall = retrievalRecall(question.expectedSourceTypes, chunks, deps.sourceTypeOf);
  const citations = citationValidity(question.requiredCitations, answerText);
  const refused = detectRefusal(events, answerText, deps.refusalMarkers ?? []);
  const correct = refusalCorrectness(question.expectedBehavior, refused);
  const passed = correct && citations === 1 && recall === 1;
  return {
    questionId: question.id,
    expectedBehavior: question.expectedBehavior,
    passed,
    retrievalRecall: recall,
    citationValidity: citations,
    refused,
  };
}

/** The persisted `eval_runs.report` payload (shared with the CLI). */
export type BuildReportRun = {
  runId: string;
  startedAt: number;
  finishedAt: number;
  results: readonly (EvalResultOutcome & { traceId?: string | null })[];
  passed: number;
  failed: number;
  skipped: number;
  budgetExceeded: boolean;
  scored: readonly EvalResultOutcome[];
  /** Total recorded spend (harness + trace-triggered pipeline costs). */
  costMicroUsd: number;
  /** Per-question cost records captured from the traces. */
  costs: readonly CostRecordLike[];
};

/** Build the aggregate report (the persisted `eval_runs.report` payload). */
export function buildReport(set: GoldenSet, run: BuildReportRun): EvalRunReport {
  const mean = (xs: readonly number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    runId: run.runId,
    setId: set.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    questions: set.questions.length,
    passed: run.passed,
    failed: run.failed,
    skipped: run.skipped,
    meanRetrievalRecall: mean(run.scored.map((r) => r.retrievalRecall)),
    meanCitationValidity: mean(run.scored.map((r) => r.citationValidity)),
    costMicroUsd: run.costMicroUsd,
    budgetExceeded: run.budgetExceeded,
    results: [...run.results],
    costs: [...run.costs],
  };
}
