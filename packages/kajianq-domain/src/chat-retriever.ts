import { Effect } from "effect";
import type { CostRecord } from "@app/contracts";
import { toStageError, type Chunk, type RoutedQuery, type Retriever } from "@app/rag-core";
import type { StoreError } from "@app/rag-core";
import type { KajianQFilters } from "./filters";

/**
 * KajianQRetriever — Smart Router stage 4 (spec §3.3): embed each routed
 * sub-query, run `similaritySearch` over both embedding tracks (ADR-0013
 * dual-track), and fuse the hit lists with Reciprocal Rank Fusion (k=60) plus
 * the spec's hierarchy bonuses. Chunks carry their fused `score` and per-rank
 * provenance so the Trace shows retrieval provenance (ADR-0007).
 */

/** RRF constant (spec §3.3: k=60). */
export const RRF_K = 60;

/** Hierarchy bonus magnitudes (spec §3.3). */
export const HIERARCHY_BONUS = {
  quran: 0.3,
  sahih: 0.25,
  hasan: 0.15,
} as const;

export type RetrieverEmbedder = {
  embed(spec: {
    texts: readonly string[];
  }): Effect.Effect<{ vectors: readonly (readonly number[])[]; cost: CostRecord }, unknown>;
};

/** Wiring-level store role: search one track; filters are opaque metadata keys. */
export type RetrieverStore = {
  similaritySearch(
    track: "primary" | "fallback",
    embedding: readonly number[],
    opts: { limit: number; filters?: Record<string, string> },
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
  /** Trace/cost sink for the embed call (the run's collection point). */
  onEmbedCost?: (cost: CostRecord) => void;
};

/** One track's hit: the chunk plus its 1-based dense rank in that search. */
type TrackHit = { chunk: Chunk; rank: number };

/**
 * Fuse per-search hit lists with RRF(k=60) plus hierarchy bonuses.
 * Exported for tests: pure, deterministic.
 */
export function rrfFuse(lists: readonly TrackHit[][], bonusOf: (chunk: Chunk) => number): Chunk[] {
  const byId = new Map<string, { chunk: Chunk; score: number; ranks: number[] }>();
  for (const list of lists) {
    for (const { chunk, rank } of list) {
      const entry = byId.get(chunk.id) ?? { chunk, score: 0, ranks: [] };
      entry.score += (1 + bonusOf(chunk)) / (RRF_K + rank);
      entry.ranks.push(rank);
      byId.set(chunk.id, entry);
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .map((e) => ({
      ...e.chunk,
      score: e.score,
      rankDense: Math.min(...e.ranks),
    }));
}

/** Hierarchy bonus from a chunk's opaque metadata (spec §3.3 magnitudes). */
export function hierarchyBonus(chunk: Chunk): number {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  let bonus = 0;
  if (meta["sourceType"] === "quran") bonus += HIERARCHY_BONUS.quran;
  if (meta["grade"] === "sahih") bonus += HIERARCHY_BONUS.sahih;
  if (meta["grade"] === "hasan") bonus += HIERARCHY_BONUS.hasan;
  return bonus;
}

/** Map the domain filters to the store's opaque metadata filter record. */
export function metadataFilters(filters: KajianQFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.madzhab) out["madzhab"] = filters.madzhab;
  if (filters.grade) out["grade"] = filters.grade;
  if (filters.textLayer) out["textLayer"] = filters.textLayer;
  return out;
}

export function createKajianQRetriever(deps: KajianQRetrieverDeps): Retriever<KajianQFilters> {
  const limit = deps.limit ?? 10;
  return {
    retrieve: (routed: RoutedQuery<KajianQFilters>) =>
      toStageError(
        "retriever",
        Effect.gen(function* () {
          if (routed.subQueries.length === 0) return [];
          const embedded = yield* deps.embedder
            .embed({ texts: routed.subQueries.map((q) => q.text) })
            .pipe(Effect.mapError((cause) => ({ cause })));
          if (deps.onEmbedCost) deps.onEmbedCost(embedded.cost);
          const filters = metadataFilters(routed.filters);
          const lists: TrackHit[][] = [];
          for (let i = 0; i < routed.subQueries.length; i += 1) {
            const vector = embedded.vectors[i];
            if (!vector) continue;
            for (const track of ["primary", "fallback"] as const) {
              const hits = yield* Effect.tryPromise({
                try: () =>
                  deps.bridge(deps.store.similaritySearch(track, vector, { limit, filters })),
                catch: (cause: unknown) => ({ cause }),
              });
              for (const hit of hits) {
                lists.push([
                  {
                    chunk: {
                      id: hit.child.id,
                      text:
                        track === "primary"
                          ? hit.child.textAr
                          : (hit.child.textId ?? hit.child.textAr),
                      metadata: hit.child.metadata,
                      rankDense: hit.rankDense,
                    },
                    rank: hit.rankDense,
                  },
                ]);
              }
            }
          }
          return rrfFuse(lists, hierarchyBonus);
        }),
      ),
  };
}
