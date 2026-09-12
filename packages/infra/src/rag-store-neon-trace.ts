import { Effect } from "effect";
import type { Trace } from "@app/contracts";
import type { RagStore } from "./rag-store";
import { constraintError, parseTrace } from "./rag-store-shared";
import { sqlEffect, type SqlRunner } from "./rag-store-neon-errors";

/**
 * Answer-trace methods of the Neon RagStore adapter, split from
 * `rag-store-neon.ts` to respect the agentic size limits. Part of the Neon
 * adapter SQL surface (ADR-0027 decision 7): the store writes/parses the
 * @app/contracts `Trace` shape verbatim (ADR-0007) — never a parallel
 * schema — and contract violations are `constraint`-class StoreErrors.
 */
export function neonTraceMethods(
  sql: SqlRunner,
): Pick<RagStore, "insertAnswerTrace" | "getAnswerTraceByMessage"> {
  return {
    insertAnswerTrace(input) {
      // Trace contract violations are constraint-class: the input, not the
      // store, is bad — deterministic, never retried into place.
      const parsed = Effect.try({
        try: () => parseTrace(input.trace),
        catch: constraintError,
      });
      // The row id is the STORE's, not the contract's: this column is `uuid`
      // while `Trace.id` is any non-empty string, so the two cannot always
      // agree. Callers must persist dependent rows (notably a chat message's
      // `answer_trace_id`, which FKs to this column) using the id returned
      // here — assuming `trace.id` instead silently broke every assistant
      // message write, which the live staging smoke caught as a 500.
      const id = crypto.randomUUID();
      return Effect.flatMap(parsed, (trace) =>
        Effect.as(
          sqlEffect(
            sql,
            () =>
              sql`
            INSERT INTO answer_traces (id, message_id, user_id, trace)
            VALUES (
              ${id}, ${input.messageId}, ${input.userId},
              ${JSON.stringify(trace)}::jsonb
            )
          ` as Promise<unknown[]>,
          ),
          id,
        ),
      );
    },

    getAnswerTraceByMessage(messageId) {
      return Effect.flatMap(
        sqlEffect(
          sql,
          () =>
            sql`
          SELECT trace FROM answer_traces WHERE message_id = ${messageId}
        ` as Promise<{ trace: unknown }[]>,
        ),
        (rows) => {
          const [row] = rows;
          if (!row) return Effect.succeed<Trace | null>(null);
          // Tolerant reader (ADR-0007 amendment): the Trace contract only ever
          // ADDS optional fields (versioned), so parseTrace accepts older
          // traces and strips unknown future keys rather than failing. Never
          // add a required field to TraceSchema without a migration of
          // persisted traces. A corrupt persisted trace is constraint-class
          // (schema drift), surfaced — never silently coerced.
          return Effect.try({
            try: () => parseTrace(row.trace) as Trace | null,
            catch: constraintError,
          });
        },
      );
    },
  };
}
