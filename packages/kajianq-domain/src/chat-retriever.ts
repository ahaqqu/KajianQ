import { Effect } from "effect";
import {
  RunContext,
  toStageError,
  // `@app/rag-core` re-exports the engine's `CostRecord` (rag-core/src/index.ts),
  // so sourcing it here keeps this module inside the repo's 5-import agentic
  // limit while `withTextLayers` is imported from its single owner (R1).
  type CostRecord,
  type RoutedQuery,
  type Retriever,
  type StoreError,
} from "@app/rag-core";
import type { KajianQFilters } from "./filters";
import {
  DEFAULT_NEIGHBOUR_CAP,
  DEFAULT_NEIGHBOUR_RADIUS,
  DEFAULT_SCOPE_EXPANSION_CAP,
  expandSurahScope,
  expandVerseNeighbours,
  createFilterRelaxation,
  filterEntries,
  hierarchyBonus,
  nextRelaxation,
  rrfFuse,
  type NeighbourChildRow,
  type ScopeChildRow,
  type TrackHit,
} from "./chat-retriever-parts";
import { withTextLayers } from "./chunk-text-layers";
/**
 * KajianQRetriever — Smart Router stage 4 (spec §3.3): embed each routed
 * sub-query, run `similaritySearch` over both embedding tracks (ADR-0013
 * dual-track), and fuse the hit lists with Reciprocal Rank Fusion (k=60) plus
 * the spec's hierarchy bonuses. Chunks carry their fused `score` and per-rank
 * provenance so the Trace shows retrieval provenance (ADR-0007).
 */

export type RetrieverEmbedder = {
  embed(spec: {
    texts: readonly string[];
    /**
     * Required on the serving seam: the embedded texts are the user's
     * sub-queries — personal data (ADR-0043 Consequences). Non-optional so
     * a call site that drops it is a compile error; the provider seam skips
     * free-tier candidates when it is set.
     */
    personalData: true;
  }): Effect.Effect<{ vectors: readonly (readonly number[])[]; cost: CostRecord }, unknown>;
};

/** Wiring-level store role: search one track; filters are opaque metadata keys. */
export type RetrieverStore = {
  similaritySearch(
    track: "primary" | "fallback",
    embedding: readonly number[],
    opts: { limit: number; filters?: Record<string, string | readonly string[]> },
  ): Effect.Effect<
    readonly {
      child: {
        id: string;
        textAr: string;
        textId: string | null;
        metadata: Record<string, unknown>;
      };
      distance: number;
      rankDense: number;
    }[],
    StoreError
  >;
  /**
   * The bounded parent-scoped child read behind ADR-0045's scope expansion:
   * a named surah's children, in the corpus's stable order, capped.
   */
  listDocChildrenByParentSourceKey(
    parentSourceKey: string,
    opts: { limit: number },
  ): Effect.Effect<readonly ScopeChildRow[], StoreError>;
  /**
   * The bounded anchored read behind ADR-0049's neighbour expansion: the
   * children within `radius` ordinals of each anchor child, in the caller's
   * priority order, capped. Anchors are opaque child ids — the store derives
   * their parent and position from the row, so the window cannot be
   * mis-anchored.
   */
  listDocChildNeighboursByChildIds(
    anchorChildIds: readonly string[],
    opts: { radius: number; limit: number },
  ): Effect.Effect<readonly NeighbourChildRow[], StoreError>;
};

/** Effect bridge the wiring injects (keeps this module free of runner imports). */
export type StoreBridge = <A>(effect: Effect.Effect<A, StoreError>) => Promise<A>;

export type KajianQRetrieverDeps = {
  store: RetrieverStore;
  embedder: RetrieverEmbedder;
  /** Runs a store Effect to a promise (the composition-root bridge). */
  bridge: StoreBridge;
  /** Per-track hits per sub-query (spec §3.7 smoke keeps this small). */
  limit?: number;
  /**
   * Budget cap for ADR-0045's surah-reference scope expansion: at most this
   * many of the named surah's children are added to the fused hits. Defaults
   * to `DEFAULT_SCOPE_EXPANSION_CAP`; `0` disables the expansion.
   */
  scopeExpansionCap?: number;
  /**
   * ADR-0049's retrieved-verse neighbourhood expansion: how many ordinals on
   * each side of a retrieved verse join the context, and the total number of
   * chunks it may add. Default to `DEFAULT_NEIGHBOUR_RADIUS` /
   * `DEFAULT_NEIGHBOUR_CAP`; `0` on **either** disables the expansion — the
   * composition root's parser accepts non-negative integers only, and the
   * expansion guards `<= 0` defensively for any other caller (review B3 of the
   * #274 fix round).
   */
  neighbourRadius?: number;
  neighbourCap?: number;
  /** Trace/cost sink for the embed call (the run's collection point). */
  onEmbedCost?: (cost: CostRecord) => void;
};

export function createKajianQRetriever(deps: KajianQRetrieverDeps): Retriever<KajianQFilters> {
  const limit = deps.limit ?? 10;
  return {
    retrieve: (routed: RoutedQuery<KajianQFilters>) =>
      toStageError(
        "retriever",
        Effect.gen(function* () {
          if (routed.subQueries.length === 0) return [];
          const embedded = yield* deps.embedder
            .embed({ texts: routed.subQueries.map((q) => q.text), personalData: true })
            .pipe(Effect.mapError((cause) => ({ cause })));
          if (deps.onEmbedCost) deps.onEmbedCost(embedded.cost);
          // The route's decision, read into the store's expressible shape. A
          // dimension the store cannot express is a typed stage failure, never
          // a dropped key: silently ignoring `grade` answers a different
          // question than the router decided to answer (chat-filter-policy.ts).
          const intended = yield* Effect.try({
            try: () => filterEntries(routed.filters),
            catch: (cause: unknown) => ({ cause }),
          });
          // The live filter set, relaxed at most once per dimension for the
          // WHOLE run. That is sound because the WHERE clause is identical on
          // both tracks — they differ only in the vector column, which the
          // `IS NOT NULL` guard screens — so an unsatisfiable dimension is
          // unsatisfiable for every search here, and probing it once per
          // sub-query per track would pay repeatedly for the same answer.
          const relaxation = createFilterRelaxation(intended);
          const lists: TrackHit[][] = [];
          for (let i = 0; i < routed.subQueries.length; i += 1) {
            const vector = embedded.vectors[i];
            if (!vector) continue;
            for (const track of ["primary", "fallback"] as const) {
              const search = (withFilters: Record<string, string[]>) =>
                Effect.tryPromise({
                  try: () =>
                    deps.bridge(
                      deps.store.similaritySearch(track, vector, { limit, filters: withFilters }),
                    ),
                  catch: (cause: unknown) => ({ cause }),
                });
              let hits = yield* search(relaxation.active());
              // Filter relaxation: a hint that matches nothing is probed away one
              // dimension at a time, and only a drop that returns hits is adopted.
              // When no single dimension is at fault the sweep ends in ONE
              // record-level retry with every remaining dimension dropped, so a
              // wrong hint cannot turn into a refusal for a question the corpus
              // can serve. The policy, its rationale and the one-diagnosis-per-run
              // bound live in `chat-filter-relaxation.ts`; this loop only runs the
              // searches it asks for, and records each probe so the trace carries
              // the machinery.
              while (hits.length === 0 && relaxation.probing()) {
                const probe = relaxation.next();
                if (probe === undefined) break;
                const retry = yield* search(probe.retained);
                const adopted = retry.length > 0;
                if (adopted) {
                  relaxation.adopt(probe.dropped);
                  hits = retry;
                }
                const run = yield* RunContext;
                run.record({
                  stage: "retriever",
                  kind: "filter_relaxed",
                  detail: {
                    // Recorded by the store's KEY — the same space `retained` is
                    // written in, so `intended − dropped` reconstructs what a
                    // search ran with. The dimension and the key are held
                    // together by `chat-filter-policy`'s exhaustive map; an entry
                    // naming EVERY live dimension (with `retained: {}`) is the
                    // record-level last resort.
                    dropped: Object.fromEntries(
                      probe.dropped.map((entry) => [entry.key, [...entry.values]]),
                    ) as Record<string, string | string[]>,
                    // What the retry actually ran with, adopted or not.
                    retained: probe.retained,
                    track,
                    hits: retry.length,
                    adopted,
                  },
                  at: run.now(),
                });
              }
              // Whatever this search concluded, it is the run's one diagnosis.
              relaxation.settle();
              for (const hit of hits) {
                lists.push([
                  {
                    chunk: {
                      id: hit.child.id,
                      text:
                        track === "primary"
                          ? hit.child.textAr
                          : (hit.child.textId ?? hit.child.textAr),
                      // The two text layers ride the chunk metadata (thermo-review
                      // A1): the assembler renders the Arabic original with the
                      // labeled translation, and the store's text columns are the
                      // only place those layers exist — without this merge the
                      // ADR-0006 rule is dead on the real answer path and the
                      // prompt silently claims an original it does not carry.
                      // `withTextLayers` (B1) is the one owner of that merge,
                      // shared with the surah-scope expansion below, so the two
                      // paths cannot drift.
                      metadata: withTextLayers(
                        hit.child.metadata,
                        hit.child.textAr,
                        hit.child.textId,
                      ),
                      rankDense: hit.rankDense,
                    },
                    rank: hit.rankDense,
                  },
                ]);
              }
            }
          }
          // The hierarchy bonuses are the spec's, including the two that were
          // missing: Kitab +0.1, and Principle +0.2 — which applies only on an
          // analogy question, so the fuse is told the intent the route read.
          const fused = rrfFuse(lists, (chunk) => hierarchyBonus(chunk, routed.intent));
          // ADR-0045: a question that names a surah also gets that surah's
          // children, read deterministically and bounded by the cap. Detection
          // runs on the verbatim question, not on a sub-query, so the scope
          // cannot be flipped by the router's paraphrase (#241).
          const expansion = yield* expandSurahScope({
            sourceText: routed.sourceText,
            existingIds: new Set(fused.map((c) => c.id)),
            cap: deps.scopeExpansionCap ?? DEFAULT_SCOPE_EXPANSION_CAP,
            store: deps.store,
            bridge: deps.bridge,
          });
          if (expansion.scope !== null) {
            const run = yield* RunContext;
            run.record({
              stage: "retriever",
              kind: "scope_expansion",
              detail: expansion.scope,
              at: run.now(),
            });
          }
          const inContext = [...fused, ...expansion.chunks];
          // ADR-0049: the neighbourhood of the verses now in context, read
          // deterministically through the same bounded-read discipline. The
          // gate requires every address a citation names to be present, and
          // the observed defect is the generator extending a retrieved verse
          // into a range whose head it was never given (#274) — so the fix is
          // to have the address, not to weaken the gate. `inContext` is both
          // the anchor source (in retrieval order, which is the read's
          // priority order) and the dedup set, so nothing already present is
          // added twice.
          const neighbours = yield* expandVerseNeighbours({
            retrieved: inContext,
            radius: deps.neighbourRadius ?? DEFAULT_NEIGHBOUR_RADIUS,
            cap: deps.neighbourCap ?? DEFAULT_NEIGHBOUR_CAP,
            store: deps.store,
            bridge: deps.bridge,
          });
          if (neighbours.detail !== null) {
            const run = yield* RunContext;
            run.record({
              stage: "retriever",
              kind: "neighbour_expansion",
              detail: neighbours.detail,
              at: run.now(),
            });
          }
          return [...inContext, ...neighbours.chunks];
        }),
      ),
  };
}
