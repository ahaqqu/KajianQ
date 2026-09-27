import type { EvalResultOutcome, EvalRunReport, GoldenQuestion, GoldenSet } from "@app/contracts";
import { BudgetExceededError } from "./budget";
import { expansionProvenance } from "./harness-expansion";
import {
  citationValidity,
  detectRefusal,
  groundedDeclineAccepts,
  refusalCorrectness,
  retrievalRecall,
} from "./scorers";
import type {
  CitationFrameLike,
  CostRecordLike,
  HarnessDeps,
  HarnessQuestionResult,
  HarnessRunResult,
  TraceEventLike,
} from "./harness-types";

/**
 * EvalHarness (#8): run a Golden Set against a chat target, score each
 * question deterministically, persist per-run results, and cap cost.
 *
 * The harness is transport-agnostic: the caller supplies a `ChatTransport`
 * (the SSE client implements it) and a `RunLedger` (the RagStore adapter
 * implements it). Scoring reads the answer trace the API persisted —
 * retrieval recall comes from the trace's `retrieval` events (plan decision
 * 3), never from client-side guesses.
 *
 * The seam types moved to `./harness-types` (the agentic-limits line cap
 * binds this file); they are re-exported here so `index.ts` and the tests
 * keep importing them from the harness.
 */
export type {
  AnswerTraceSource,
  ChatTransport,
  ChatTransportResult,
  HarnessDeps,
  HarnessQuestionResult,
  HarnessRunResult,
  RunLedger,
} from "./harness-types";

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
      const outcome = scoreQuestion(question, reply.text, events, deps, reply.citations);
      const result: HarnessQuestionResult = { ...outcome, traceId: reply.traceId };
      try {
        await deps.ledger.saveResult(runId, question.id, outcome, reply.traceId);
      } catch (err) {
        // A ledger write failure fails THIS question — its evidence was not
        // persisted — but it must not ALSO fabricate a "skipped" entry for a
        // question that was asked and scored. The previous shape pushed both,
        // so two questions produced four rows and two phantom skips, which made
        // the smoke exit non-zero for an infrastructure reason while the report
        // disagreed with its own question count. Only a transport/trace failure,
        // which yields no score at all, is a skip.
        result.passed = false;
        result.notes = [`ledger_write_failed: ${err instanceof Error ? err.message : String(err)}`];
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

/**
 * Score one question from its answer text, trace events, and — when the
 * transport carried one — the server's citations frame. Citation validity
 * prefers the frame (ADR-0040: a label in it is grounded by construction),
 * then the trace's reviewer `grounded` labels, then the text through the
 * injected citation grammar (see `citationValidity`).
 *
 * Refusal correctness accepts the refusal signal, and — for the rare `refuse`
 * question that opted into it (#244) — a grounded decline; the opt-in lives on
 * the question, so no other verdict can change (see `groundedDeclineAccepts`).
 *
 * When the caller names the scope-expansion origin label
 * (`deps.expansionOrigin`), the outcome also carries what the expansion
 * contributed (C1): the number of expansion-origin refs and the recall the
 * fused refs alone would have scored. `retrievalRecall` itself stays exactly
 * what it always was — the metric is not redefined; the provenance is added
 * beside it so the loosening is visible instead of inferred.
 */
export function scoreQuestion(
  question: GoldenQuestion,
  answerText: string,
  events: readonly TraceEventLike[],
  deps: Pick<
    HarnessDeps,
    "sourceTypeOf" | "refusalMarkers" | "citationGrammar" | "dateAssertions" | "expansionOrigin"
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
  // The additive acceptance is inert unless the question opted in AND expects
  // a refusal: `expectedBehavior`'s union is not widened, so a question that
  // does not carry `acceptance` cannot inherit this path.
  const groundedDecline =
    question.expectedBehavior === "refuse" && question.acceptance !== undefined
      ? groundedDeclineAccepts({
          answerText,
          acceptance: question.acceptance.groundedDecline,
          frame,
          events,
          ...(deps.citationGrammar !== undefined ? { grammar: deps.citationGrammar } : {}),
          ...(deps.dateAssertions !== undefined ? { assertsDate: deps.dateAssertions } : {}),
        })
      : false;
  const correct = refusalCorrectness(question.expectedBehavior, refused) || groundedDecline;
  const passed = correct && citations === 1 && recall === 1;
  return {
    questionId: question.id,
    expectedBehavior: question.expectedBehavior,
    passed,
    retrievalRecall: recall,
    citationValidity: citations,
    refused,
    // A pass the refusal signal did NOT produce says so on the persisted row,
    // so an operator reading `passed: true, refused: false` learns which
    // rendering satisfied the question instead of guessing.
    ...(groundedDecline && !refused ? { notes: ["grounded_decline_accepted"] } : {}),
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
