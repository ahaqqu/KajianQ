import { Effect } from "effect";
import type { Chunk, StoreError } from "@app/rag-core";
import { expansionChunk } from "./chat-scope-expansion";

/**
 * Retrieved-verse neighbourhood expansion (ADR-0049, #274) — the second
 * trigger for ADR-0045's deterministic read.
 *
 * ADR-0045 widens the context around a surah the **question named**; this
 * widens it around the verses **retrieval returned**. The failure it exists to
 * remove is the generator extending a retrieved verse into a citation range
 * whose head it was never given — the observed `gs-v0-001` incident, where the
 * context held `QS. 3:2` and the draft cited `QS. 3:1-2`, so the deterministic
 * gate withheld an answerable question. The gate is right to withhold an
 * address nobody retrieved, so the fix is to put the address in the context —
 * `QS. 3:1` is one ordinal step from `QS. 3:2` and the store knows that.
 *
 * Three properties are load-bearing:
 *
 * - **The anchor is a retrieved row, not a derived position.** The read is
 *   keyed on the child ids already in context, and the adapter derives each
 *   anchor's parent and `ordinal` from the stored row. A second source of truth
 *   for where a chunk sits (a metadata number mapped to an ordinal) would add
 *   the wrong verses *silently* — the failure mode this whole change exists to
 *   prevent.
 * - **Bounded by an explicit radius and cap**, both configured at the
 *   composition root. Uncapped, a radius of one would have added a measured
 *   p50 of 46 chunks to a Quran-bearing query (the staging window's own
 *   traces), roughly doubling the prompt; the cap is what keeps the expansion
 *   from becoming the bulk of the context, and it is reported on the trace.
 * - **The caller's order is the priority order.** Anchors are read in the
 *   order the retrieval produced them, so a truncated read spends its budget
 *   on the neighbourhood of the best-ranked evidence — the evidence the
 *   answer is most likely to cite — rather than on an arbitrary subset.
 */

/**
 * The chunk-provenance label neighbour chunks carry (ADR-0049). Fused hits
 * leave `origin` unset and surah-scope chunks carry `scope_expansion`, so a
 * trace reader distinguishes the three retrieval paths without inferring a
 * path from rank or score.
 */
export const NEIGHBOUR_EXPANSION_ORIGIN = "verse_neighbours";

/**
 * Default radius: the verses immediately before and after a retrieved verse.
 * One is the smallest window that can close the observed defect (a range's
 * head or tail one ordinal away from the verse that was retrieved); a wider
 * one multiplies the candidate set against the cap for no measured case.
 * Configured at the composition root (`NEIGHBOUR_EXPANSION_RADIUS`).
 */
export const DEFAULT_NEIGHBOUR_RADIUS = 1;

/**
 * Default budget: at most this many chunks the expansion may add to one query,
 * matching ADR-0045's `SCOPE_EXPANSION_CAP` scale so the two deterministic
 * expansions are bounded alike. Against a measured p50 of 46 candidate
 * neighbours on Quran-bearing queries, this is what keeps the widening a
 * bounded addition instead of a second context. Configured at the composition
 * root (`NEIGHBOUR_EXPANSION_CAP`), which accepts **non-negative** integers
 * only: `0` is the operator's disable and a negative value is a typed config
 * failure when the chat wiring builds — the process itself boots green and
 * every `/v1/chat` request answers 503 (review B3 of the #274 fix round; R2
 * corrected the timing, which is per request, not at boot). The knob an
 * operator sets and the sentence an operator reads must say the same thing. The
 * `<= 0`
 * short-circuit below is the domain module's own defensive guard for a caller
 * that is not that parser, not a second documented spelling of "off".
 */
export const DEFAULT_NEIGHBOUR_CAP = 12;

/** The structural store read the expansion needs (the `RagStore` seam subset). */
export type NeighbourStore = {
  listDocChildNeighboursByChildIds(
    anchorChildIds: readonly string[],
    opts: { radius: number; limit: number },
  ): Effect.Effect<readonly NeighbourChildRow[], StoreError>;
};

/** One neighbour row as the read returns it (embeddings are always null). */
export type NeighbourChildRow = {
  id: string;
  textAr: string;
  textId: string | null;
  metadata: Record<string, unknown>;
};

/** Runs one store Effect to a promise (the composition-root bridge). */
export type NeighbourBridge = <A>(effect: Effect.Effect<A, StoreError>) => Promise<A>;

/** What the expansion contributed, plus the trace detail describing it. */
export type NeighbourExpansion = {
  chunks: readonly Chunk[];
  /**
   * Null when the expansion did not run — no retrieved verse to anchor on, or
   * disabled by config. Nothing is recorded then: there is no read to describe,
   * and an empty detail would claim machinery that never ran.
   */
  detail: {
    /** The anchor ids actually read, **in the read's priority order**. */
    anchors: string[];
    returned: number;
    radius: number;
    cap: number;
    truncated: boolean;
  } | null;
};

/**
 * The domain pack's anchor rule: a retrieved chunk is a verse when its corpus
 * provenance says so. Kept here (never in the engine) because `quran` is
 * product vocabulary — the engine's read takes opaque ids and learns nothing
 * about what they contain.
 */
function isVerse(chunk: Chunk): boolean {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  return meta["sourceType"] === "quran";
}

/**
 * Read the neighbourhood of every retrieved verse, bounded by `radius` and
 * `cap`, and return the chunks that are not already in context.
 *
 * `retrieved` is the whole set already in context — fused hits and ADR-0045's
 * surah-scope chunks, in that order — and it doubles as the dedup set, so a
 * verse already in context (by either path) is never added twice and a caller
 * cannot pass the two out of step. Returns no chunks and a null detail when
 * `radius <= 0` or `cap <= 0` (the composition root passes non-negative values
 * only, so in production this is `0`, the documented disable — review B3), and
 * when no retrieved chunk is a verse — in both cases without issuing a store
 * read at all, so a query that cannot benefit pays nothing.
 */
export function expandVerseNeighbours(input: {
  retrieved: readonly Chunk[];
  radius: number;
  cap: number;
  store: NeighbourStore;
  bridge: NeighbourBridge;
}): Effect.Effect<NeighbourExpansion, { cause: unknown }> {
  return Effect.gen(function* () {
    if (input.radius <= 0 || input.cap <= 0) return { chunks: [], detail: null };
    // The dedup set is every id already in context (whatever path produced it);
    // the anchor list is the verses among them, once each, in retrieval order —
    // the read's priority order and therefore the cap's truncation order.
    const inContext = new Set(input.retrieved.map((chunk) => chunk.id));
    const unique = [...new Set(input.retrieved.filter(isVerse).map((chunk) => chunk.id))];
    if (unique.length === 0) return { chunks: [], detail: null };
    // Read one past the cap: a full `cap + 1` result is the exact signal that
    // more neighbours exist than the budget allows — no second count query,
    // and no guessing from a full-looking window (ADR-0045's rule, reused).
    const rows = yield* Effect.tryPromise({
      try: () =>
        input.bridge(
          input.store.listDocChildNeighboursByChildIds(unique, {
            radius: input.radius,
            limit: input.cap + 1,
          }),
        ),
      catch: (cause: unknown) => ({ cause }),
    });
    const truncated = rows.length > input.cap;
    const chunks: Chunk[] = [];
    for (const row of rows.slice(0, input.cap)) {
      if (inContext.has(row.id)) continue;
      chunks.push(expansionChunk(row, NEIGHBOUR_EXPANSION_ORIGIN));
    }
    return {
      chunks,
      detail: {
        anchors: unique,
        returned: chunks.length,
        radius: input.radius,
        cap: input.cap,
        truncated,
      },
    };
  });
}
