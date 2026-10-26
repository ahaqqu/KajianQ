import type { EvalResultOutcome, EvalRunReport, GoldenQuestion, GoldenSet } from "@app/contracts";
import { Budget, BudgetExceededError } from "./budget";
import { ledgerFailureNote, skippedOutcome } from "./harness-outcomes";
import { scoreQuestion } from "./harness-score";
import type {
  CitationFrameLike,
  CitationGrammar,
  CitationIdentity,
  CostRecordLike,
  QuoteEquivalence,
  TraceEventLike,
} from "./harness-types";

export { scoreQuestion } from "./harness-score";

/** EvalHarness: run a Golden Set against a chat target, score each question
 * deterministically, persist per-run results, and cap cost. Transport-agnostic:
 * the caller supplies a `ChatTransport` and a `RunLedger`, and scoring reads the
 * answer trace the API persisted rather than client-side guesses. */

export type ChatTransportResult = {
  text: string;
  messageId: string | null;
  traceId: string | null;
  /** The server's structured citations frame (ADR-0040), when the transport consumed
   * one; otherwise citation scoring falls back to `grounded` labels, then the text. */
  citations?: CitationFrameLike | null;
};

export interface ChatTransport {
  ask(question: GoldenQuestion): Promise<ChatTransportResult>;
}

/** Fetch one answer's trace events by message id (the store adapter bridges). */
export interface AnswerTraceSource {
  eventsByMessage(messageId: string): Promise<readonly TraceEventLike[] | null>;
}

/** The eval-ledger persistence role (the RagStore adapter bridges): `createRun`
 * first so every `saveResult` and the report carry the real run id, then
 * `saveResult` per question, then `refreshRun` for the final report in a single
 * idempotent write. */
export interface RunLedger {
  createRun(label: string, report: unknown): Promise<string>;
  /** Idempotent upsert of the final report row (by run id). */
  refreshRun(runId: string, label: string, report: unknown): Promise<void>;
  /** Persist one question's outcome — a scored one or a transport skip; a failed
   * write leaves the report with `ledgerFailureNote` and the store with nothing. */
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
  /** Chunk-id → citation-label resolver (the chunk's own `citation` metadata);
   * the trace carries only ids, so address recall needs this join. */
  citationOf: (chunkId: string) => string | undefined;
  budget: Budget;
  /** Refusal markers in the answer text (domain vocabulary, caller-supplied). */
  refusalMarkers?: readonly string[];
  /** The citation grammar for the text fallback, supplied by the composition
   * root (the engine stays agnostic) so scorer and gate normalize identically;
   * omitted, scoring uses the byte-exact substring check. */
  citationGrammar?: CitationGrammar;
  /** Whether the address dimension decides a question's `passed`. Default true: the
   * eval gate requires the exact address. The deployed smoke turns it off so the
   * dimension is REPORTED without gating while a known retrieval gap stands. */
  gateAddressRecall?: boolean;
  /** The canonical citation-identity resolver, supplied by the composition root
   * (the engine compares opaque keys). Omitted, citation validity keeps the
   * exact-label comparison; supplied, a required citation is also satisfied by
   * a parallel narration of it. */
  citationIdentity?: CitationIdentity;
  /** The broader resolver the REPORTED identity-satisfied block reads: every group
   * the gate may read plus those signed as the same ruling. Supplied only by a
   * composition root that curates that relation; omitted, no reported block is
   * written, so a forgotten delivery publishes no figure rather than the gate's
   * own relation under the reported name. Never read by `passed`. */
  reportedCitationIdentity?: CitationIdentity;
  /** The opaque `origin` label the domain pack puts on chunks its scope expansion
   * added (ADR-0045), supplied by the composition root — the engine must not
   * hard-code a caller's label. When set, each outcome records the scope path's
   * contribution; omitted, no block is written. */
  expansionOrigin?: string;
  /** The opaque `origin` label the domain pack puts on chunks its citation-label
   * lookup added (ADR-0058). Supplying it makes the provenance block record a
   * label-only question's lookup contribution; the engine never names the label. */
  lookupOrigin?: string;
  /** The opaque `origin` label the domain pack puts on the rows its caller-priority
   * guarantee promotes (ADR-0062). The guarantee moves and labels fused rows without
   * adding any, so supplying it keeps those rows inside `fusedOnlySourceTypeRecall`
   * instead of letting a promotion read as a deterministic arm's rescue. */
  callerPriorityOrigin?: string;
  /** Language- or corpus-specific quote equivalences, supplied by the composition
   * root and applied after the scorer's generic fold, so the engine ships no language
   * policy. Omitted, quotes are compared under the generic fold alone. */
  quoteEquivalences?: readonly QuoteEquivalence[];
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

/** Run the whole set, creating the run FIRST so every `saveResult` and the report
 * carry the real run id. Per question: ask → read trace → score → persist → check
 * budget; a transport failure skips the question and keeps the run going, and a
 * budget hit aborts the remaining questions. */
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
      // The remainder is deliberately uncounted; the CLI's exit policy reddens on it.
      break;
    }
    try {
      const reply = await deps.transport.ask(question);
      const events = reply.messageId
        ? ((await deps.traces.eventsByMessage(reply.messageId)) ?? [])
        : [];
      // The trace's cost records feed the report directly; the accumulator counted them.
      for (const event of events) {
        if (event.cost) costs.push(event.cost);
      }
      const outcome = scoreQuestion(question, reply.text, events, deps, reply.citations);
      const result: HarnessQuestionResult = { ...outcome, traceId: reply.traceId };
      try {
        await deps.ledger.saveResult(runId, question.id, outcome, reply.traceId);
      } catch (err) {
        // A write failure fails THIS question — its evidence was not persisted —
        // and never fabricates a skip. Only a transport/trace failure is a skip.
        // The reported block is that same row's verdict over the same evidence, so
        // it takes the same correction: one row never carries two verdicts.
        result.passed = false;
        if (result.identitySatisfied !== undefined) {
          result.identitySatisfied = { ...result.identitySatisfied, passed: false };
        }
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
      // A transport skip gets a ledger row like every other outcome, and its own
      // failed write is noted on the report's copy, never thrown.
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

  // Skipped questions are excluded from the scored means by their explicit flag.
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

const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * The reported identity-satisfied figures over the scored rows that carry the
 * block: how many would pass, how many were measured, and their mean address
 * recall. `undefined` when no row carries one. One derivation for the persisted
 * report and the CLI summary, so the printed figure and the stored one cannot
 * drift apart.
 */
export function identitySatisfiedSummary(
  scored: readonly EvalResultOutcome[],
): { passed: number; measured: number; meanCitationAddressRecall: number | null } | undefined {
  const blocks = scored.flatMap((row) =>
    row.identitySatisfied === undefined ? [] : [row.identitySatisfied],
  );
  if (blocks.length === 0) return undefined;
  return {
    passed: blocks.filter((block) => block.passed).length,
    measured: blocks.length,
    meanCitationAddressRecall: mean(blocks.map((block) => block.citationAddressRecall)),
  };
}

export function buildReport(set: GoldenSet, run: BuildReportRun): EvalRunReport {
  const quoteFidelity = run.scored.flatMap((r) =>
    r.quoteFidelity === undefined ? [] : [r.quoteFidelity],
  );
  const identitySatisfied = identitySatisfiedSummary(run.scored);
  return {
    runId: run.runId,
    setId: set.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    questions: set.questions.length,
    passed: run.passed,
    failed: run.failed,
    skipped: run.skipped,
    meanSourceTypeRecall: mean(run.scored.map((r) => r.sourceTypeRecall)),
    // Over the scored rows that carry the measurement: a row persisted before the
    // metric existed is excluded, never counted as zero.
    meanCitationAddressRecall: mean(
      run.scored.flatMap((r) =>
        r.citationAddressRecall === undefined ? [] : [r.citationAddressRecall],
      ),
    ),
    meanCitationValidity: mean(run.scored.map((r) => r.citationValidity)),
    meanQuoteFidelity: mean(quoteFidelity),
    // The mean's denominator, so a perfect mean over two answers cannot read as one over
    // a hundred; absent when no answer was measured, like the mean's own null.
    ...(quoteFidelity.length > 0 ? { quoteFidelityMeasured: quoteFidelity.length } : {}),
    // REPORTED, never gating: the exact numbers above stay the gate's; these say what
    // the same run would read if a signed identity satisfied the requirement. Absent
    // when no row carried the block (no reported identity map was injected).
    ...(identitySatisfied !== undefined
      ? {
          identitySatisfiedPassed: identitySatisfied.passed,
          meanIdentitySatisfiedCitationAddressRecall: identitySatisfied.meanCitationAddressRecall,
        }
      : {}),
    costMicroUsd: run.costMicroUsd,
    budgetExceeded: run.budgetExceeded,
    results: [...run.results],
    costs: [...run.costs],
  };
}
