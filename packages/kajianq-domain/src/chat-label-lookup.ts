import { Effect } from "effect";
import type { Chunk, StoreError } from "@app/rag-core";
import { expansionChunk, type ScopeChildRow } from "./chat-scope-expansion";
import { citationLabelScan, type DroppedCitationLabel } from "./chat-citation-reference";

/**
 * Citation-label lookup (ADR-0058) — the deterministic retrieval arm that reads
 * the chunks a label named in the question addresses.
 *
 * Dense search ranks by topic similarity, and an exact number is an
 * **identifier**, not a topic: the neighbours around an exact label's row
 * outscore it, so the passage the user named can sit outside every fused list
 * while the corpus carries it. The answer is a directed read of the corpus's own
 * identity for that label, added alongside the fused hits — never instead of
 * them — with no embedding and no model call.
 *
 * Three properties are load-bearing:
 *
 * - **The trigger is the verbatim question**, not a sub-query, so the router's
 *   paraphrase cannot move the lookup (the same rule ADR-0045's scope read
 *   follows).
 * - **The read is bounded** by an explicit cap, configured at the composition
 *   root; `0` disables the arm and a non-positive cap issues no read.
 * - **A label the corpus does not carry adds nothing.** The lookup reads rows,
 *   it never renders one from the string it parsed, so an absent label cannot
 *   become evidence and the generator still refuses.
 */

/** The provenance label lookup chunks carry. Fused hits leave `origin` unset, so a
 * trace reader can tell the two paths apart without inferring from rank. */
export const CITATION_LOOKUP_ORIGIN = "citation_lookup";

/**
 * Default budget: at most this many chunks one query's label lookup may add.
 * A label normally addresses one row; the budget also bounds a label that
 * resolves to several rows and a question naming several labels, while staying
 * well below the fused set's own volume. Configured at the composition root
 * (`LABEL_LOOKUP_CAP`); this is the default when unset.
 */
export const DEFAULT_LABEL_LOOKUP_CAP = 8;

/** The structural store read the lookup needs (the `RagStore` seam subset). */
export type LabelLookupStore = {
  findDocChildrenByMetadata(
    match: Readonly<Record<string, string | number>>,
    opts: { limit: number },
  ): Effect.Effect<readonly ScopeChildRow[], StoreError>;
};

/** Runs one store Effect to a promise (the composition-root bridge). */
export type LabelLookupBridge = <A>(effect: Effect.Effect<A, StoreError>) => Promise<A>;

export type LabelLookup = {
  chunks: readonly Chunk[];
  /** Null when the question named no label and no citation-shaped span —
   * nothing to record. */
  detail: {
    /** The labels the lookup resolved, normalized, in first-appearance order. */
    labels: string[];
    /** The labels no stored row carried. */
    missing: string[];
    /** The spans the grammar saw but the lookup did not resolve, and why. */
    dropped: DroppedCitationLabel[];
    returned: number;
    cap: number;
    truncated: boolean;
  } | null;
};

/**
 * Read the chunks the question's citation labels address and add the ones the
 * caller does not already hold, bounded by `cap`. A recognised label with no
 * stored row is recorded in `missing` — machinery the trace must show, and the
 * trace's own statement that no evidence was invented for it.
 */
export function lookupCitationLabels(input: {
  sourceText: string | undefined;
  existingIds: ReadonlySet<string>;
  cap: number;
  store: LabelLookupStore;
  bridge: LabelLookupBridge;
}): Effect.Effect<LabelLookup, { cause: unknown }> {
  return Effect.gen(function* () {
    if (input.cap <= 0) return { chunks: [], detail: null };
    const scan = citationLabelScan(input.sourceText ?? "");
    // A question that named no citation-shaped span at all is the only state
    // with nothing to record. A span seen and not resolved still records the
    // event: "named no label" and "declined this label" must stay distinct.
    if (scan.references.length === 0 && scan.dropped.length === 0) {
      return { chunks: [], detail: null };
    }
    const references = scan.references;
    const chunks: Chunk[] = [];
    const missing: string[] = [];
    const added = new Set<string>();
    let truncated = false;
    for (const reference of references) {
      // Read one past the budget: a full `cap + 1` result is the exact signal
      // that this label addresses more rows than the read could offer.
      const rows = yield* Effect.tryPromise({
        try: () =>
          input.bridge(
            input.store.findDocChildrenByMetadata(reference.match, { limit: input.cap + 1 }),
          ),
        catch: (cause: unknown) => ({ cause }),
      });
      if (rows.length === 0) missing.push(reference.label);
      if (rows.length > input.cap) truncated = true;
      for (const row of rows) {
        if (input.existingIds.has(row.id) || added.has(row.id)) continue;
        if (chunks.length >= input.cap) {
          truncated = true;
          break;
        }
        added.add(row.id);
        chunks.push(expansionChunk(row, CITATION_LOOKUP_ORIGIN));
      }
    }
    return {
      chunks,
      detail: {
        labels: references.map((reference) => reference.label),
        missing,
        dropped: scan.dropped,
        returned: chunks.length,
        cap: input.cap,
        truncated,
      },
    };
  });
}
