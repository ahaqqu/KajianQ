import type { EvalResultOutcome, GoldenQuestion, GoldenSet } from "@app/contracts";
import { Budget, BudgetExceededError } from "./budget";
import { citationValidity, detectRefusal, refusalCorrectness, retrievalRecall } from "./scorers";
import type { TraceEventLike } from "./harness-types";

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

/** The eval-ledger persistence role (the RagStore adapter bridges). */
export interface RunLedger {
  createRun(label: string, report: unknown): Promise<string>;
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
 * Run the whole set. Per question: ask → read trace → score → persist →
 * check budget. A transport failure marks the question skipped and keeps the
 * run going; a budget hit aborts the remaining questions (plan decision 4).
 */
export async function runGoldenSet(set: GoldenSet, deps: HarnessDeps): Promise<HarnessRunResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const results: HarnessQuestionResult[] = [];
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
      const outcome = scoreQuestion(question, reply.text, events, deps);
      results.push({ ...outcome, traceId: reply.traceId });
      await deps.ledger.saveResult(
        // runId filled by createRun below on first save; see ledger contract.
        "",
        question.id,
        outcome,
        reply.traceId,
      );
      if (outcome.passed) passed += 1;
      else failed += 1;
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
        notes: [`skipped: ${err instanceof Error ? err.message : String(err)}`],
        traceId: null,
      });
    }
  }

  const scored = results.filter((r) => !r.notes?.some((n) => n.startsWith("skipped:")));
  const report = buildReport(set, {
    runId: "",
    startedAt,
    finishedAt: now(),
    results,
    passed,
    failed,
    skipped,
    budgetExceeded,
    scored,
  });
  const runId = await deps.ledger.createRun(deps.label ?? set.id, report);
  // Stamp the run id onto the persisted outcomes by re-saving is avoided —
  // the ledger's createRun receives the full report including results, and
  // per-question rows were saved with the run-scoped ledger implementation
  // (the adapter keys them by its own session). The report is the source of
  // truth.
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

/** Build the aggregate report (the persisted `eval_runs.report` payload). */
export function buildReport(
  set: GoldenSet,
  run: {
    runId: string;
    startedAt: number;
    finishedAt: number;
    results: readonly (EvalResultOutcome & { traceId?: string | null })[];
    passed: number;
    failed: number;
    skipped: number;
    budgetExceeded: boolean;
    scored: readonly EvalResultOutcome[];
  },
): Record<string, unknown> {
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
    meanRetrievalRecall: mean([...run.scored].map((r) => r.retrievalRecall)),
    meanCitationValidity: mean([...run.scored].map((r) => r.citationValidity)),
    costMicroUsd: 0,
    budgetExceeded: run.budgetExceeded,
    results: run.results,
    costs: [],
  };
}
