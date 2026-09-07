import { Effect } from "effect";
import type { RagStore } from "./rag-store";
import { sqlEffect, type SqlRunner } from "./rag-store-neon-errors";

/**
 * Report-ledger methods of the Neon RagStore adapter, split from
 * `rag-store-neon.ts` to keep the composition root pure wiring (and to
 * respect the agentic size limits). Part of the Neon adapter SQL surface
 * (ADR-0027 decision 7): batch/eval reports persist to `eval_runs`
 * (kajianq-traceability rule 4) — the report is stored verbatim as JSONB so
 * the persisted trace remains the single source of truth.
 */
export function neonEvalMethods(sql: SqlRunner): Pick<RagStore, "insertEvalRun"> {
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
  };
}
