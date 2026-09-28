import type { Chunk } from "@app/rag-core";
import type { KajianQFilters } from "./filters";

/**
 * The pure half of the retriever: Reciprocal Rank Fusion (spec §3.3, k=60), the
 * hierarchy bonuses, and the metadata-filter mapping. Split out of
 * `chat-retriever.ts` for the 300-line agentic cap — that module is the wiring
 * (`RetrieverStore`/`RetrieverEmbedder` in, `Retriever` out); this one is the
 * arithmetic the fused path and its tests read. No state, no store, no effects.
 */
/** RRF constant (spec §3.3: k=60). */
export const RRF_K = 60;

/** Hierarchy bonus magnitudes (spec §3.3). */
export const HIERARCHY_BONUS = {
  quran: 0.3,
  sahih: 0.25,
  hasan: 0.15,
} as const;
/** One track's hit: the chunk plus its 1-based dense rank in that search. */
export type TrackHit = { chunk: Chunk; rank: number };
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
