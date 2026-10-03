import type { EvalResultOutcome, GoldenQuestion } from "@app/contracts";
import { StoreError } from "@app/rag-core";
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
 * deterministically and with no judge: the number of scope-origin refs and the
 * recall the fused refs alone would have scored. A `fusedOnlyRetrievalRecall`
 * below the reported `retrievalRecall` is the report's own statement that the
 * expansion carried the question. The metric itself is never redefined.
 *
 * **"The fused refs alone" means the refs that carry NO origin label** (review
 * A4 of the #274 fix round). Every deterministic expansion path labels its own
 * chunks — the fused tracks leave `origin` unset by contract — so the leg is
 * defined by that absence rather than by "not this one label". Excluding only
 * `expansionOrigin` counted ADR-0049's `verse_neighbours` chunks as fused, and
 * on a question the neighbour path carried the metric silently became equal to
 * the reported recall, destroying exactly the statement this block exists to
 * make. A future expansion cannot reintroduce that by forgetting a name here:
 * whichever label it writes, its chunks leave the fused-only leg.
 *
 * The reported `expansion.chunks` is deliberately still the **scope** path's
 * count (ADR-0045's published meaning, ADR-0049's Consequences), so the block
 * is emitted when the scoped path ran — a labelled chunk or the typed event —
 * and a neighbour-only question reports no block rather than a block whose
 * `chunks` would have to be redefined. The neighbour path's own contribution is
 * on the trace: its typed event and each ref's `origin`.
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
        // Absence of an origin label is what makes a ref a fused hit; see the
        // A4 note above — a named exclusion list would have to be kept in step
        // with every expansion path, and it was not.
        input.chunks.filter((chunk) => chunk.origin === undefined),
        input.sourceTypeOf,
      ),
    },
  };
}

/**
 * The text for anything a `catch` can hand us (review A2). `cause` is `unknown`
 * by contract (`store-error.ts:43`), so a wrapped vendor exception, a bare
 * string, a plain object and `undefined` all arrive here.
 */
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
      // Circular or otherwise unserialisable: the caller's fallback applies.
      return "";
    }
  }
  return String(value);
}

/**
 * The note a failed ledger write leaves on a question's outcome. Shared by
 * the scored and the skipped write path so a persistence failure reads the
 * same either way. It is **report-only**: a write that fails leaves no row,
 * and an ambiguous one (the INSERT committed, the response was lost) leaves a
 * row still carrying the bare cause — so the report can name a cause the store
 * does not, never the other way round.
 *
 * The cause is read from what the throwable actually carries (review A2).
 * `StoreError` — the seam's own typed failure, and the error this path really
 * sees — is an `Error` with an EMPTY `message` (`store-error.ts:43`): `kind`
 * and the wrapped `cause` are its whole payload, and its own `toString` is the
 * bare word `"StoreError"`. Reading `.message` first, as the round-2 shape did,
 * rendered `ledger_write_failed: ` with no cause at all — the blank red this
 * ticket exists to remove, on the one run whose store evidence is already
 * missing.
 */
export function ledgerFailureNote(err: unknown): string {
  const cause =
    err instanceof StoreError ? `${err.kind}: ${thrownText(err.cause)}` : thrownText(err);
  return `ledger_write_failed: ${cause === "" ? "no cause" : cause}`;
}

/**
 * The outcome for a question whose transport failed (#290). The question was
 * never asked and never scored, so every scored field is zero and `skipped`
 * is true. That flag is what keeps this mode unmistakable from the two scored
 * failures it otherwise resembles on `passed`/`citationValidity` alone:
 * #274's ungrounded-citation refusal is a scored outcome with `refused: true`,
 * and an ordinary scorer failure is a scored outcome with `skipped` absent.
 * The `notes` entry is the durable cause: the harness persists this same
 * outcome to the eval ledger, so a row that lands and the report's entry for
 * this question name the same message. A write that does not land has no row,
 * and only the report gains the `ledger_write_failed:` note on top (see
 * `ledgerFailureNote`).
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
