import { Effect } from "effect";
import {
  RunContext,
  toStageError,
  // `@app/rag-core` re-exports the engine's `CostRecord`, so sourcing it here keeps
  // this module inside the repo's import cap.
  type CostRecord,
  type RoutedQuery,
  type Retriever,
  type StoreError,
} from "@app/rag-core";
import type { KajianQFilters } from "./filters";
import {
  DEFAULT_LABEL_LOOKUP_CAP,
  DEFAULT_NEIGHBOUR_CAP,
  DEFAULT_NEIGHBOUR_RADIUS,
  DEFAULT_SCOPE_EXPANSION_CAP,
  expandRetrievedSurahScope,
  expandSurahScope,
  expandVerseNeighbours,
  createFilterRelaxation,
  filterEntries,
  hierarchyBonus,
  lookupCitationLabels,
  rrfFuse,
  type NeighbourChildRow,
  type ScopeChildRow,
  type TrackHit,
} from "./chat-retriever-parts";
import { withTextLayers } from "./chunk-text-layers";
/**
 * KajianQRetriever — Smart Router stage 4: embed each routed sub-query, search both
 * embedding tracks (ADR-0013 dual-track), and fuse the hits with Reciprocal Rank
 * Fusion (k=60) plus the spec's hierarchy bonuses.
 */

export type RetrieverEmbedder = {
  embed(spec: {
    texts: readonly string[];
    /** Required on the serving seam: the embedded texts are the user's sub-queries, i.e.
     * personal data. Non-optional so a call site that drops it is a compile error; the
     * provider seam then skips free-tier candidates. */
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
  /** The bounded, capped read of a surah's children, in the corpus's order,
   * optionally beginning at an ordinal lower bound — a named verse's position. */
  listDocChildrenByParentSourceKey(
    parentSourceKey: string,
    opts: { limit: number; fromOrdinal?: number },
  ): Effect.Effect<readonly ScopeChildRow[], StoreError>;
  /** The bounded read of the children within `radius` ordinals of each anchor child, in
   * the caller's priority order; anchors are opaque child ids, so the window cannot be
   * mis-anchored. */
  listDocChildNeighboursByChildIds(
    anchorChildIds: readonly string[],
    opts: { radius: number; limit: number },
  ): Effect.Effect<readonly NeighbourChildRow[], StoreError>;
  /** The bounded exact-match read of the children carrying a label's opaque metadata
   * pairs — the one read the citation-label arm issues. */
  findDocChildrenByMetadata(
    match: Readonly<Record<string, string | number>>,
    opts: { limit: number },
  ): Effect.Effect<readonly ScopeChildRow[], StoreError>;
};

/** Effect bridge the wiring injects (keeps this module free of runner imports). */
export type StoreBridge = <A>(effect: Effect.Effect<A, StoreError>) => Promise<A>;

export type KajianQRetrieverDeps = {
  store: RetrieverStore;
  embedder: RetrieverEmbedder;
  bridge: StoreBridge;
  /** Per-track hits per sub-query (spec §3.7 smoke keeps this small). */
  limit?: number | undefined;
  /** Budget cap for ADR-0045's surah reads — the surah the question names and a retrieved
   * verse's short surah share it, the named read first; `0` disables both. */
  scopeExpansionCap?: number | undefined;
  /** ADR-0049's neighbourhood expansion: ordinals per side and chunks added, defaulting to
   * `DEFAULT_NEIGHBOUR_RADIUS` / `DEFAULT_NEIGHBOUR_CAP`; `0` on **either** disables it. */
  neighbourRadius?: number | undefined;
  neighbourCap?: number | undefined;
  /** Budget cap for the citation-label lookup over the labels a question names,
   * defaulting to `DEFAULT_LABEL_LOOKUP_CAP`; `0` disables it. */
  labelLookupCap?: number | undefined;
};

export function createKajianQRetriever(deps: KajianQRetrieverDeps): Retriever<KajianQFilters> {
  const limit = deps.limit ?? 10;
  return {
    retrieve: (routed: RoutedQuery<KajianQFilters>) =>
      toStageError(
        "retriever",
        Effect.gen(function* () {
          if (routed.subQueries.length === 0) return [];
          const run = yield* RunContext;
          const embedded = yield* deps.embedder
            .embed({ texts: routed.subQueries.map((q) => q.text), personalData: true })
            .pipe(Effect.mapError((cause) => ({ cause })));
          // The embed call's cost rides the run's own sink like every other provider
          // call's, so the answer's trace sums to its provider calls by construction.
          run.record({
            stage: "retriever",
            kind: "llm_call",
            detail: { purpose: "embed" },
            cost: embedded.cost,
            at: run.now(),
          });
          // The route's decision, read into the store's expressible shape. A dimension
          // the store cannot express is a typed stage failure, never a dropped key:
          // silently ignoring `grade` answers a different question than the router chose.
          const intended = yield* Effect.try({
            try: () => filterEntries(routed.filters),
            catch: (cause: unknown) => ({ cause }),
          });
          // The live filter set, relaxed at most once per dimension for the WHOLE run.
          // The WHERE clause is identical on both tracks and they differ only in the
          // vector column, so an unsatisfiable dimension is unsatisfiable for every
          // search here, and probing it per sub-query per track would pay twice.
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
              // Filter relaxation: a hint that matches nothing is probed away one dimension
              // at a time, and only a drop that returns hits is adopted; when no single
              // dimension is at fault the sweep ends in one record-level retry with every
              // remaining dimension dropped (policy: `chat-filter-relaxation.ts`).
              while (hits.length === 0 && relaxation.probing()) {
                const probe = relaxation.next();
                if (probe === undefined) break;
                const retry = yield* search(probe.retained);
                const adopted = retry.length > 0;
                if (adopted) {
                  relaxation.adopt(probe.dropped);
                  hits = retry;
                }
                run.record({
                  stage: "retriever",
                  kind: "filter_relaxed",
                  detail: {
                    // Recorded by the store's KEY — the same space `retained` is written
                    // in, so `intended − dropped` reconstructs what a search ran with; an
                    // entry naming EVERY live dimension is the record-level last resort.
                    dropped: Object.fromEntries(
                      probe.dropped.map((entry) => [entry.key, [...entry.values]]),
                    ) as Record<string, string | string[]>,
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
                      // The two text layers ride the chunk metadata — the store's text
                      // columns are their only source — and `withTextLayers` owns the
                      // merge for both retrieval paths, so they cannot drift.
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
          // The hierarchy bonuses are the spec's; the Principle bonus applies only on an
          // analogy question, so the fuse is told the intent the route read.
          const fused = rrfFuse(lists, (chunk) => hierarchyBonus(chunk, routed.intent));
          const scopeCap = deps.scopeExpansionCap ?? DEFAULT_SCOPE_EXPANSION_CAP;
          // Detection runs on the verbatim question, not on a sub-query, so the
          // router's paraphrase cannot flip the scope (ADR-0045).
          const expansion = yield* expandSurahScope({
            sourceText: routed.sourceText,
            existingIds: new Set(fused.map((c) => c.id)),
            cap: scopeCap,
            store: deps.store,
            bridge: deps.bridge,
          });
          const scoped = [...fused, ...expansion.chunks];
          // ADR-0045's second trigger: a fused verse can be one of a short surah's
          // verses while its opening — the verse that may answer the question — sits
          // outside every list. The same bounded read completes it from that opening,
          // out of what the named read left; the record names that remainder beside
          // the configured cap, so neither the target set nor the starvation hides.
          const completion = yield* expandRetrievedSurahScope({
            retrieved: fused,
            existingIds: new Set(scoped.map((chunk) => chunk.id)),
            cap: scopeCap,
            remaining: scopeCap - expansion.chunks.length,
            store: deps.store,
            bridge: deps.bridge,
          });
          // One record per scope read, in read order: the named read first, then each
          // completion target — including one the shared budget never reached.
          const scopeDetails = [
            ...(expansion.scope === null ? [] : [expansion.scope]),
            ...completion.scopes,
          ];
          for (const detail of scopeDetails) {
            run.record({
              stage: "retriever",
              kind: "scope_expansion",
              detail,
              at: run.now(),
            });
          }
          const expanded = [...scoped, ...completion.chunks];
          // An exact citation label is an identifier, not a topic: the passage it
          // names can lose a similarity race to its own neighbours, so the label
          // the question wrote is read from the corpus's identity for it. Detection
          // runs on the verbatim question, like the scope read above; the arm adds
          // chunks beside the fused hits and never renders one from the string.
          const lookup = yield* lookupCitationLabels({
            sourceText: routed.sourceText,
            existingIds: new Set(expanded.map((chunk) => chunk.id)),
            cap: deps.labelLookupCap ?? DEFAULT_LABEL_LOOKUP_CAP,
            store: deps.store,
            bridge: deps.bridge,
          });
          if (lookup.detail !== null) {
            run.record({
              stage: "retriever",
              kind: "citation_lookup",
              detail: lookup.detail,
              at: run.now(),
            });
          }
          const inContext = [...expanded, ...lookup.chunks];
          // ADR-0049: the neighbourhood of the verses now in context — the gate requires
          // every address a citation names, so the fix is to have the address, not to weaken
          // the gate. `inContext` is both the anchor source (in retrieval order) and the dedup set.
          const neighbours = yield* expandVerseNeighbours({
            retrieved: inContext,
            radius: deps.neighbourRadius ?? DEFAULT_NEIGHBOUR_RADIUS,
            cap: deps.neighbourCap ?? DEFAULT_NEIGHBOUR_CAP,
            store: deps.store,
            bridge: deps.bridge,
          });
          if (neighbours.detail !== null) {
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
