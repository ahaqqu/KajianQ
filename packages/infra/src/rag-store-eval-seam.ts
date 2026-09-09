import type { Effect } from "effect";
import type { EvalRunReport, IngestionReport } from "@app/contracts";
import type { StoreError } from "@app/rag-core";

/**
 * Eval-ledger read/write half of the `RagStore` seam (issue #8), split from
 * `rag-store.ts` to respect the agentic 300-line file cap — the `RagStore`
 * interface extends this one, so consumers see one unchanged seam.
 */

// -- Batch reports (kajianq-traceability rule 4) ----------------------------

/**
 * Persist an `IngestionReport` (or any batch/eval report) to the report
 * ledger (`eval_runs`). Idempotent by id: re-running with the same run id
 * refreshes label and report in place. The report is stored verbatim as
 * JSONB so the persisted trace remains the single source of truth. The
 * eval harness (thermo-review A5) reads the eval-run rows back through
 * `getEvalRun`, typed as the `EvalRunReport` it writes.
 */
export interface RagStoreEvalRunWrite {
  insertEvalRun(input: {
    /** Defaults to a fresh UUID. */
    id?: string;
    label?: string;
    report: IngestionReport | EvalRunReport;
  }): Effect.Effect<string, StoreError>;

  /**
   * Idempotent upsert of the final eval report onto its run row
   * (thermo-review A3/A4: the harness creates the run first, then refreshes
   * the row with the completed `EvalRunReport` — no blank-runId writes, no
   * caller-side stamping).
   */
  refreshEvalRun(
    runId: string,
    label: string,
    report: EvalRunReport,
  ): Effect.Effect<void, StoreError>;
}

// -- Eval ledger reads/writes (issue #8) ------------------------------------

export interface RagStoreEvalLedger {
  /**
   * The per-question outcome the harness scored for one run. `outcome` is
   * the @app/contracts `EvalResultOutcome` shape verbatim (JSONB); the
   * harness resolves the question id through its own seam, so
   * `questionId` stays a loose string reference (mirroring the
   * `eval_results.question_id` loose-ref precedent). Returns the row id.
   */
  insertEvalResult(input: {
    runId: string;
    questionId: string;
    /** The answer's message id, when the question hit the chat pipeline. */
    answerMessageId?: string | null;
    answerTraceId?: string | null;
    outcome: unknown;
  }): Effect.Effect<string, StoreError>;

  /** Fetch one run's persisted report by id; null when unknown. */
  getEvalRun(id: string): Effect.Effect<EvalRunReport | null, StoreError>;

  /** List run ledger rows (id + label), newest first, capped at `limit`. */
  listEvalRuns(opts: {
    limit: number;
  }): Effect.Effect<readonly { id: string; label: string | null; createdAt: number }[], StoreError>;

  /** All per-question outcomes for one run, in insertion order. */
  getEvalResultsByRun(runId: string): Effect.Effect<
    readonly {
      id: string;
      questionId: string;
      answerTraceId: string | null;
      outcome: unknown;
    }[],
    StoreError
  >;
}
