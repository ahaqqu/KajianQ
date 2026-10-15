import { Effect } from "effect";
import type { Chunk, StoreError } from "@app/rag-core";
import { expansionChunk } from "./chat-scope-expansion";

/**
 * Retrieved-verse neighbourhood expansion (ADR-0049) — the second trigger for
 * ADR-0045's deterministic read: it widens the context around the verses
 * **retrieval returned**, where ADR-0045 widens around a surah the question named.
 * The citation gate withholds a range whose head was never in context, so the fix is to
 * put that address in the context — one ordinal away, and the store knows it.
 *
 * Three properties are load-bearing:
 *
 * - **The anchor is a retrieved row**, never a derived position (the adapter derives parent
 *   and `ordinal` from it);
 * - **The read is bounded by an explicit radius and cap**, configured at the composition root;
 * - **The caller's order is the priority order**, so a truncated read spends its budget on the
 *   best-ranked evidence.
 */

/** The chunk-provenance label neighbour chunks carry — fused hits leave `origin` unset
 * and surah-scope chunks carry `scope_expansion`, so a trace reader never infers a
 * retrieval path from rank. */
export const NEIGHBOUR_EXPANSION_ORIGIN = "verse_neighbours";

/** Default radius: the verses immediately before and after a retrieved verse — the smallest
 * window that closes a range's missing head or tail. Configured at the composition root. */
export const DEFAULT_NEIGHBOUR_RADIUS = 1;

/**
 * Default budget: at most this many chunks one query's expansion may add, matching
 * ADR-0045's `SCOPE_EXPANSION_CAP` scale so the two deterministic expansions are
 * bounded alike. `NEIGHBOUR_EXPANSION_CAP` accepts non-negative integers only — `0`
 * disables and a negative value is a typed config failure — and the `<= 0` guard below
 * covers callers that are not that parser.
 */
export const DEFAULT_NEIGHBOUR_CAP = 12;

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

export type NeighbourBridge = <A>(effect: Effect.Effect<A, StoreError>) => Promise<A>;

export type NeighbourExpansion = {
  chunks: readonly Chunk[];
  /** Null when the expansion did not run — no retrieved verse to anchor on, or disabled
   * by config; an empty detail would claim machinery that never ran. */
  detail: {
    /** The anchor ids actually read, **in the read's priority order**. */
    anchors: string[];
    returned: number;
    radius: number;
    cap: number;
    truncated: boolean;
  } | null;
};

/** A retrieved chunk is a verse when its corpus provenance says so; the rule is
 * product vocabulary, so it stays out of the engine. */
function isVerse(chunk: Chunk): boolean {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  return meta["sourceType"] === "quran";
}

/**
 * Read the neighbourhood of every retrieved verse, bounded by `radius` and `cap`, and
 * return the chunks that are not already in context.
 * `retrieved` doubles as the dedup set, so a verse already there is never added twice.
 * Returns no chunks and a null detail when `radius <= 0`, `cap <= 0`, or no retrieved
 * chunk is a verse — without issuing a store read, so a query that cannot benefit pays
 * nothing.
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
    // Dedup set: every id already in context. Anchor list: the verses among them,
    // once each, in retrieval order — the cap's truncation order.
    const inContext = new Set(input.retrieved.map((chunk) => chunk.id));
    const unique = [...new Set(input.retrieved.filter(isVerse).map((chunk) => chunk.id))];
    if (unique.length === 0) return { chunks: [], detail: null };
    // Read one past the cap: a full `cap + 1` result proves more neighbours exist.
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
