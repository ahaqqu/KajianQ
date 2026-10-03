import type { EvalResultOutcome, EvalRunReport, GoldenQuestion, GoldenSet } from "@app/contracts";
import { Budget, BudgetExceededError } from "./budget";
import { expansionProvenance, ledgerFailureNote, skippedOutcome } from "./harness-outcomes";
import {
  behaviorAccepted,
  citationValidity,
  detectRefusal,
  groundedAnswer,
  retrievalRecall,
} from "./scorers";
import type {
  CitationFrameLike,
  CitationGrammar,
  CostRecordLike,
  TraceEventLike,
} from "./harness-types";

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
  /**
   * The server's structured citations frame (ADR-0040), when the transport
   * consumed one. Absent for a transport that does not carry it (a fake, an
   * older client); citation scoring then falls back to the trace's `grounded`
   * labels and finally the answer text.
   */
  citations?: CitationFrameLike | null;
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
  /**
   * Persist one question's outcome — a scored one, or a transport skip (#290).
   * Not every reported outcome has a row: a write that fails leaves the report
   * with `ledgerFailureNote` and the store with nothing (see that helper).
   */
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
  /**
   * The citation grammar the scorer uses on the text fallback (domain
   * vocabulary, caller-supplied — the engine stays agnostic). Supplied by the
   * CLI composition root from `@app/kajianq-domain`, so the scorer and the
   * deterministic gate normalize labels identically. Omitted in a unit
   * context: scoring then falls back to the byte-exact substring check.
   */
  citationGrammar?: CitationGrammar;
  /**
   * The opaque `origin` label the domain pack puts on chunks its scope
   * expansion added (ADR-0045), supplied by the composition root exactly like
   * `refusalMarkers`/`citationGrammar` — the engine package must not hard-code
   * a caller's label. When set, each scored outcome records the expansion's
   * contribution to that question (C1: a scoped pass is visible in the report,
   * never folded silently into `retrievalRecall`). Omitted = no accounting and
   * no `expansion` block on the outcome.
   */
  expansionOrigin?: string;
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
 * → check budget. A transport failure marks the question skipped, persists
 * that skip with its error (#290), and keeps the run going; a budget hit
 * aborts the remaining questions (plan decision 4).
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
      // The remainder is deliberately uncounted; the CLI's exit policy reddens on it (#364).
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
      const outcome = scoreQuestion(question, reply.text, events, deps, reply.citations);
      const result: HarnessQuestionResult = { ...outcome, traceId: reply.traceId };
      try {
        await deps.ledger.saveResult(runId, question.id, outcome, reply.traceId);
      } catch (err) {
        // A write failure fails THIS question — its evidence was not persisted
        // — but must not fabricate a "skipped" entry for a question that was
        // asked and scored: the previous shape pushed both, which failed the
        // smoke for an infrastructure reason while the report contradicted its
        // own question count. Only a transport/trace failure is a skip.
        result.passed = false;
        result.notes = [ledgerFailureNote(err)];
      }
      results.push(result);
      if (result.passed) passed += 1;
      else failed += 1;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        budgetExceeded = true;
        break;
      }
      skipped += 1;
      // #290: a transport skip is an outcome like every other one — it gets a
      // ledger row naming the question and the error, so the gate's red is
      // actionable from `eval_results` alone. The store keeps the object handed
      // to it, so a failed write is noted on the report's OWN copy below, never
      // on that row's object; and it is never thrown, so one bad row cannot
      // take the report — or the questions after it — down with it.
      const skip = skippedOutcome(question, err);
      let reported = skip;
      try {
        await deps.ledger.saveResult(runId, question.id, skip, null);
      } catch (ledgerErr) {
        reported = { ...skip, notes: [...(skip.notes ?? []), ledgerFailureNote(ledgerErr)] };
      }
      results.push({ ...reported, traceId: null });
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

/**
 * Score one question from its answer text, trace events, and — when the
 * transport carried one — the server's citations frame (see `citationValidity`).
 * Trap rule + residual: `behaviorAccepted` (scorers.ts) + ADR-0046.
 */
export function scoreQuestion(
  question: GoldenQuestion,
  answerText: string,
  events: readonly TraceEventLike[],
  deps: Pick<
    HarnessDeps,
    "sourceTypeOf" | "refusalMarkers" | "citationGrammar" | "expansionOrigin"
  >,
  frame?: CitationFrameLike | null,
): EvalResultOutcome {
  const retrieval = events.filter((e) => e.kind === "retrieval").at(-1);
  const chunks = retrieval?.detail?.chunks ?? [];
  const recall = retrievalRecall(question.expectedSourceTypes, chunks, deps.sourceTypeOf);
  const citations = citationValidity(question.requiredCitations, answerText, {
    frame,
    events,
    ...(deps.citationGrammar !== undefined ? { grammar: deps.citationGrammar } : {}),
  });
  const refused = detectRefusal(events, answerText, deps.refusalMarkers ?? []);
  const grounded = groundedAnswer({ frame, events });
  const correct = behaviorAccepted(question.expectedBehavior, refused, grounded);
  const passed = correct && citations === 1 && recall === 1;
  return {
    questionId: question.id,
    expectedBehavior: question.expectedBehavior,
    passed,
    retrievalRecall: recall,
    citationValidity: citations,
    refused,
    ...expansionProvenance({
      expectedSourceTypes: question.expectedSourceTypes,
      chunks,
      events,
      sourceTypeOf: deps.sourceTypeOf,
      ...(deps.expansionOrigin !== undefined ? { expansionOrigin: deps.expansionOrigin } : {}),
    }),
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
