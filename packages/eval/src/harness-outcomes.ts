import type { EvalResultOutcome, GoldenQuestion } from "@app/contracts";
import type { ChunkRefLike, TraceEventLike } from "./harness-types";
import { retrievalRecall } from "./scorers";

/**
 * Per-question outcome helpers, split out of `harness.ts` to respect the
 * agentic size limits: the ADR-0045 expansion provenance, the transport-skip
 * outcome (#290), and the ledger-write-failure note both write paths share.
 */

/**
 * The per-question expansion provenance (ADR-0045; C1 of #243's review).
 *
 * The gate's `retrievalRecall` reads the retrieval event's chunk refs and never
 * inspects their `origin` label, so for a question that names a reference the
 * scored leg is satisfied **by construction** whenever the scoped read works —
 * a fused-track regression on exactly those questions would otherwise be
 * invisible in the report. This function says what the expansion contributed,
 * deterministically and with no judge: the number of expansion-origin refs and
 * the recall the fused refs alone would have scored. A `fusedOnlyRetrievalRecall`
 * below the reported `retrievalRecall` is the report's own statement that the
 * expansion carried the question. The metric itself is never redefined.
 */
export function expansionProvenance(input: {
  expectedSourceTypes: readonly string[];
  chunks: readonly ChunkRefLike[];
  events: readonly TraceEventLike[];
  sourceTypeOf: (chunkId: string) => string | undefined;
  /** Opaque caller label (domain vocabulary stays at the composition root). */
  expansionOrigin?: string;
}): { expansion?: EvalResultOutcome["expansion"] } {
  const { expansionOrigin } = input;
  if (expansionOrigin === undefined) return {};
  const expansionChunks = input.chunks.filter((chunk) => chunk.origin === expansionOrigin);
  // A recognised-but-empty scope still counts as "the scoped path ran": it
  // records `chunks: 0` beside the fused-only figure rather than staying silent.
  const scopedPathRan =
    expansionChunks.length > 0 || input.events.some((e) => e.kind === "scope_expansion");
  if (!scopedPathRan) return {};
  return {
    expansion: {
      chunks: expansionChunks.length,
      fusedOnlyRetrievalRecall: retrievalRecall(
        input.expectedSourceTypes,
        input.chunks.filter((chunk) => chunk.origin !== expansionOrigin),
        input.sourceTypeOf,
      ),
    },
  };
}

/**
 * The note a failed ledger write leaves on a question's outcome. Shared by
 * the scored and the skipped write path so a persistence failure reads the
 * same either way: the question's evidence is not in the store, and the
 * report says so rather than silently showing an unpersisted result.
 */
export function ledgerFailureNote(err: unknown): string {
  return `ledger_write_failed: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * The outcome for a question whose transport failed (#290). The question was
 * never asked and never scored, so every scored field is zero and `skipped`
 * is true. That flag is what keeps this mode unmistakable from the two scored
 * failures it otherwise resembles on `passed`/`citationValidity` alone:
 * #274's ungrounded-citation refusal is a scored outcome with `refused: true`,
 * and an ordinary scorer failure is a scored outcome with `skipped` absent.
 * The `notes` entry is the durable cause — the harness persists this same
 * outcome to the eval ledger, so the run's `eval_results` row and its report
 * carry one identical message and cannot disagree about why.
 */
export function skippedOutcome(question: GoldenQuestion, err: unknown): EvalResultOutcome {
  return {
    questionId: question.id,
    expectedBehavior: question.expectedBehavior,
    passed: false,
    retrievalRecall: 0,
    citationValidity: 0,
    refused: false,
    skipped: true,
    notes: [`skipped: ${err instanceof Error ? err.message : String(err)}`],
  };
}
