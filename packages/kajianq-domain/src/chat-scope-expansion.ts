import { Effect } from "effect";
import type { Chunk, StoreError } from "@app/rag-core";
import { withTextLayers } from "./chunk-text-layers";
import { surahSourceKey } from "./quran-source";
import { detectSurahReference } from "./surah-reference";

/**
 * Surah-reference scoped expansion (ADR-0045) — the retrieval half.
 *
 * When a question names a surah (or a verse inside one), the fused dense
 * retrieval may carry no part of that surah at all: `QS. 1:1` measures at
 * dense rank 929 / 8,305 for a whole-surah meta-question (#142), far outside
 * an HNSW scan, and the router's sub-query paraphrase flips even the reachable
 * verses in and out (#241). So the named surah's children are retrieved
 * **deterministically** — a direct bounded read of the surah parent's
 * children, no embedding, no LLM — and added alongside the fused hits.
 *
 * Two properties are load-bearing:
 *
 * - **Detection runs on the verbatim question** (`RoutedQuery.sourceText`),
 *   never on a sub-query: the failure mode being fixed is nondeterministic
 *   wording, so the scope must not depend on it.
 * - **The read is bounded by an explicit cap** and reported on the trace. An
 *   uncapped expansion would put Al-Baqarah's 286 verses into a prompt; the
 *   cap is a configurable number (not a magic constant inside the engine's
 *   logic), the window is the parent's stable `ordinal` order, and the trace
 *   says how many children were added and whether the cap truncated them.
 */

/** The opaque scope key the trace carries; the engine never interprets it. */
export const SCOPE_KEY_SURAH = "surah";

/**
 * The chunk-provenance label expansion chunks carry (ADR-0045). Fused hits
 * leave `origin` unset, so a trace reader can tell the two retrieval paths
 * apart without inferring intent from rank or score.
 */
export const SCOPE_EXPANSION_ORIGIN = "scope_expansion";

/**
 * Default expansion budget: at most this many of the named surah's children.
 * 12 retrieves a short surah whole (Al-Fatihah, 7 verses) and gives a long one
 * (Al-Baqarah, 286) its deterministic opening window, while staying small
 * against the fused set (`limit` hits per track per sub-query) so expansion
 * can never become the bulk of the prompt. Configured at the composition root
 * (apps/api reads `SCOPE_EXPANSION_CAP`); this is the default when unset.
 */
export const DEFAULT_SCOPE_EXPANSION_CAP = 12;

/** The structural store read the expansion needs (the `RagStore` seam subset). */
export type ScopeStore = {
  listDocChildrenByParentSourceKey(
    parentSourceKey: string,
    opts: { limit: number },
  ): Effect.Effect<readonly ScopeChildRow[], StoreError>;
};

/** One child row as the scope read returns it (embeddings are always null). */
export type ScopeChildRow = {
  id: string;
  textAr: string;
  textId: string | null;
  metadata: Record<string, unknown>;
};

/** Runs one store Effect to a promise (the composition-root bridge). */
export type ScopeBridge = <A>(effect: Effect.Effect<A, StoreError>) => Promise<A>;

/** What the expansion contributed, plus the trace detail describing it. */
export type ScopeExpansion = {
  chunks: readonly Chunk[];
  /** Null when the question named no scope — nothing to record. */
  scope: {
    key: string;
    value: string;
    returned: number;
    cap: number;
    truncated: boolean;
  } | null;
};

/**
 * Build the expansion chunk. The text-layer metadata comes from the shared
 * `withTextLayers` owner (B1) — the same function the fused path calls — so the
 * assembler's Arabic + labeled-translation rule (ADR-0006) cannot go dead on
 * exactly the chunks this feature adds, and the rule has one implementation.
 */
function scopeChunk(row: ScopeChildRow): Chunk {
  return {
    id: row.id,
    text: row.textAr,
    origin: SCOPE_EXPANSION_ORIGIN,
    metadata: withTextLayers(row.metadata, row.textAr, row.textId),
  };
}

/**
 * Detect a surah reference in the question and read that surah's children,
 * bounded by `cap`. Returns no chunks and a null scope when the question names
 * no surah, or when the cap disables expansion (`cap <= 0`); returns a scope
 * with `returned: 0` when the reference was recognised but the store held no
 * children for it — a recognised-but-empty scope is machinery the trace must
 * still show.
 *
 * `existingIds` are the ids the fused tracks already produced; a child already
 * retrieved is not duplicated, so `returned` counts only what the expansion
 * actually added.
 */
export function expandSurahScope(input: {
  sourceText: string | undefined;
  existingIds: ReadonlySet<string>;
  cap: number;
  store: ScopeStore;
  bridge: ScopeBridge;
}): Effect.Effect<ScopeExpansion, { cause: unknown }> {
  return Effect.gen(function* () {
    const ref = detectSurahReference(input.sourceText ?? "");
    if (ref === null || input.cap <= 0) return { chunks: [], scope: null };
    // Read one past the cap: a full `cap + 1` result is the exact signal that
    // the scope holds more children than the budget allows (no second count
    // query, and no guessing from a full-looking window).
    const rows = yield* Effect.tryPromise({
      try: () =>
        input.bridge(
          input.store.listDocChildrenByParentSourceKey(surahSourceKey(ref.surah), {
            limit: input.cap + 1,
          }),
        ),
      catch: (cause: unknown) => ({ cause }),
    });
    const truncated = rows.length > input.cap;
    const chunks: Chunk[] = [];
    for (const row of rows.slice(0, input.cap)) {
      if (input.existingIds.has(row.id)) continue;
      chunks.push(scopeChunk(row));
    }
    return {
      chunks,
      scope: {
        key: SCOPE_KEY_SURAH,
        value: ref.ayah !== undefined ? `${ref.surah}:${ref.ayah}` : String(ref.surah),
        returned: chunks.length,
        cap: input.cap,
        truncated,
      },
    };
  });
}
