import { Effect } from "effect";
import { parseIngestionReport, type IngestionReport } from "@app/contracts";
import type { RagStore } from "./rag-store";
import { sqlEffect, type SqlRunner } from "./rag-store-neon-errors";

/**
 * Eval-ledger methods of the Neon RagStore adapter, split from
 * `rag-store-neon.ts` to keep the composition root pure wiring (and to
 * respect the agentic size limits). Part of the Neon adapter SQL surface
 * (ADR-0027 decision 7): the run report and per-question outcomes persist to
 * `eval_runs` / `eval_results` verbatim as JSONB (kajianq-traceability rule
 * 4) so the persisted records stay the single source of truth.
 */

/** Row shape of the run-ledger SELECTs (snake_case wire form). */
type EvalRunRow = { id: string; label: string | null; report: unknown; created_at: unknown };

/** Row shape of the per-result SELECT (snake_case wire form). */
type EvalResultRow = {
  id: string;
  question_id: string;
  answer_trace_id: string | null;
  outcome: unknown;
};

export function neonEvalMethods(
  sql: SqlRunner,
): Pick<
  RagStore,
  | "insertEvalRun"
  | "insertEvalResult"
  | "getEvalRun"
  | "listEvalRuns"
  | "getEvalResultsByRun"
> {
  return {
    insertEvalRun(input) {
      const id = input.id ?? crypto.randomUUID();
      // Idempotent by run id: re-running the same ingestion run refreshes the
      // label and report so the ledger stays the single source of truth.
      return Effect.map(
        sqlEffect(
          sql,
          () =>
            sql`
          INSERT INTO eval_runs (id, label, report)
          VALUES (
            ${id}, ${input.label ?? null},
            ${JSON.stringify(input.report)}::jsonb
          )
          ON CONFLICT (id) DO UPDATE
            SET label = EXCLUDED.label,
                report = EXCLUDED.report,
                created_at = now()
          RETURNING id
        ` as Promise<{ id: string }[]>,
        ),
        (rows) => rows[0]?.id ?? id,
      );
    },

    insertEvalResult(input) {
      const id = crypto.randomUUID();
      return Effect.as(
        sqlEffect(
          sql,
          () =>
            sql`
          INSERT INTO eval_results (
            id, run_id, question_id, answer_trace_id, outcome
          )
          VALUES (
            ${id},
            ${input.runId}::uuid,
            ${input.questionId}::uuid,
            ${input.answerTraceId ?? null},
            ${JSON.stringify(input.outcome)}::jsonb
          )
        ` as Promise<unknown[]>,
        ),
        id,
      );
    },

    getEvalRun(id) {
      return Effect.map(
        sqlEffect(
          sql,
          () =>
            sql`
          SELECT id, label, report, created_at FROM eval_runs WHERE id = ${id}::uuid
        ` as Promise<EvalRunRow[]>,
        ),
        (rows) => {
          const [row] = rows;
          if (!row) return null;
          // Tolerant reader: the report is stored verbatim as JSONB; a
          // mis-shaped report is a data defect surfaced as a failed parse —
          // never silently coerced into an empty report.
          return parseIngestionReport(row.report);
        },
      );
    },

    listEvalRuns(opts) {
      return Effect.map(
        sqlEffect(
          sql,
          () =>
            sql`
          SELECT id, label, created_at
          FROM eval_runs
          ORDER BY created_at DESC
          LIMIT ${opts.limit}
        ` as Promise<{ id: string; label: string | null; created_at: unknown }[]>,
        ),
        (rows) =>
          rows.map((r) => ({
            id: r.id,
            label: r.label,
            createdAt: new Date(String(r.created_at)).getTime(),
          })),
      );
    },

    getEvalResultsByRun(runId) {
      return Effect.map(
        sqlEffect(
          sql,
          () =>
            sql`
          SELECT id, question_id, answer_trace_id, outcome
          FROM eval_results
          WHERE run_id = ${runId}::uuid
          ORDER BY created_at
        ` as Promise<EvalResultRow[]>,
        ),
        (rows) =>
          rows.map((r) => ({
            id: r.id,
            questionId: r.question_id,
            answerTraceId: r.answer_trace_id,
            outcome: r.outcome,
          })),
      );
    },
  };
}