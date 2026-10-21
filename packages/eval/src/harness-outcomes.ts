import type { EvalResultOutcome, GoldenQuestion } from "@app/contracts";
import { StoreError } from "@app/rag-core";
import type { ChunkRefLike, TraceEventLike } from "./harness-types";
import { sourceTypeRecall } from "./scorers";

/** Per-question outcome helpers, split out of `harness.ts` to respect the agentic
 * size limits: the expansion provenance, the transport-skip outcome, and the
 * ledger-write-failure note both write paths share. */

/**
 * The per-question expansion provenance: the number of scope-origin refs and the
 * source-type recall the fused refs alone would have scored.
 *
 * `sourceTypeRecall` never inspects a ref's `origin` label, so for a question that
 * names a reference the scored leg is satisfied by construction whenever the
 * scoped read works, and a fused-track regression on exactly those questions
 * would otherwise be invisible. A `fusedOnlySourceTypeRecall` below the reported
 * `sourceTypeRecall` states that the expansion carried the question; the metric
 * itself is never redefined.
 *
 * **"The fused refs alone" means the refs that carry NO origin label** — every
 * expansion path labels its own chunks, so whichever label a future expansion
 * writes, its chunks leave the fused-only leg. `expansion.chunks` stays the
 * **scope** path's count; a neighbour-only question reports no block.
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
  // A recognised-but-empty scope still counts as "the scoped path ran".
  const scopedPathRan =
    expansionChunks.length > 0 || input.events.some((e) => e.kind === "scope_expansion");
  if (!scopedPathRan) return {};
  return {
    expansion: {
      chunks: expansionChunks.length,
      fusedOnlySourceTypeRecall: sourceTypeRecall(
        input.expectedSourceTypes,
        // Absence of an origin label is what makes a ref a fused hit.
        input.chunks.filter((chunk) => chunk.origin === undefined),
        input.sourceTypeOf,
      ),
    },
  };
}

/** The text for anything a `catch` can hand us: `cause` is `unknown` by
 * contract, so a wrapped exception, a bare string, a plain object and
 * `undefined` all arrive here. */
function thrownText(value: unknown): string {
  if (value === undefined || value === null) return "no cause";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message !== "" ? value.message : value.name;
  if (typeof value === "object") {
    const { message } = value as { message?: unknown };
    if (typeof message === "string" && message !== "") return message;
    try {
      return JSON.stringify(value);
    } catch {
      // Circular or otherwise unserialisable: nothing to report.
      return "";
    }
  }
  return String(value);
}

/**
 * The note a failed ledger write leaves on a question's outcome, shared by the
 * scored and the skipped write path. It is **report-only**: a failed write leaves
 * no row, and an ambiguous one (the INSERT committed, the response was lost)
 * leaves a row carrying the bare cause — the report can name a cause the store
 * does not, never the other way round. `StoreError` has an EMPTY `message`, so the
 * cause is read from `kind` and the wrapped `cause`.
 */
export function ledgerFailureNote(err: unknown): string {
  const cause =
    err instanceof StoreError ? `${err.kind}: ${thrownText(err.cause)}` : thrownText(err);
  return `ledger_write_failed: ${cause === "" ? "no cause" : cause}`;
}

/**
 * The outcome for a question whose transport failed: never asked, never scored, so
 * every scored field is zero and `skipped` is true — the flag that keeps this mode
 * unmistakable from the two scored failures it resembles on `passed` /
 * `citationValidity` alone.
 *
 * The `notes` entry is the durable cause, persisted to the eval ledger with this
 * same outcome; a write that does not land has no row.
 */
export function skippedOutcome(question: GoldenQuestion, err: unknown): EvalResultOutcome {
  return {
    questionId: question.id,
    expectedBehavior: question.expectedBehavior,
    passed: false,
    sourceTypeRecall: 0,
    citationAddressRecall: 0,
    citationValidity: 0,
    refused: false,
    skipped: true,
    notes: [`skipped: ${err instanceof Error ? err.message : String(err)}`],
  };
}
