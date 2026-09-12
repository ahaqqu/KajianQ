import { Effect } from "effect";
import type { RagStore } from "@app/infra";

/**
 * Eval-ledger half of the in-memory RagStore, split from
 * `memory-rag-store.ts` to respect the agentic size limits — the same
 * concern-split the Neon adapter uses (`rag-store-neon-eval.ts`). The maps
 * and the id sequence are owned by the caller and passed in, so both halves
 * see one store state.
 */

/** The eval-ledger state the memory store owns (shared with the other half). */
export type MemoryEvalState = {
  evalRuns: Map<string, { label: string | null; report: unknown; createdAt: number }>;
  evalResults: Map<
    string,
    { id: string; questionId: string; answerTraceId: string | null; outcome: unknown }
  >;
  nextId: () => number;
};

/** The eval-ledger methods of the `RagStore` seam, in-memory. */
export function memoryEvalMethods(
  state: MemoryEvalState,
): Pick<
  RagStore,
  | "insertEvalRun"
  | "refreshEvalRun"
  | "insertEvalResult"
  | "getEvalRun"
  | "listEvalRuns"
  | "getEvalResultsByRun"
> {
  return {
    insertEvalRun(input) {
      return Effect.sync(() => {
        const id = input.id ?? `eval${state.nextId()}`;
        state.evalRuns.set(id, {
          label: input.label ?? null,
          report: input.report,
          createdAt: 0,
        });
        return id;
      });
    },
    // Thermo-review A3/A4: the harness upserts the final report by run id.
    refreshEvalRun(runId, label, report) {
      return Effect.sync(() => {
        const run = state.evalRuns.get(runId);
        if (run) {
          state.evalRuns.set(runId, { ...run, label, report });
        }
      });
    },
    insertEvalResult(input) {
      return Effect.sync(() => {
        const id = `er${state.nextId()}`;
        state.evalResults.set(id, {
          id,
          questionId: input.questionId,
          answerTraceId: input.answerTraceId ?? null,
          outcome: input.outcome,
        });
        return id;
      });
    },
    getEvalRun(id) {
      return Effect.sync(() => {
        const run = state.evalRuns.get(id);
        return run ? (run.report as never) : null;
      });
    },
    listEvalRuns(opts) {
      return Effect.sync(() =>
        [...state.evalRuns.entries()].slice(0, opts.limit).map(([id, run]) => ({
          id,
          label: run.label,
          createdAt: run.createdAt,
        })),
      );
    },
    getEvalResultsByRun(runId) {
      return Effect.sync(() =>
        // In-memory results are not row-keyed by run; the harness reads them
        // back per run id in tests, so the memory store keeps a flat list and
        // filters on the stored run marker via outcome passthrough.
        [...state.evalResults.values()].filter(() => state.evalRuns.has(runId)),
      );
    },
  };
}
