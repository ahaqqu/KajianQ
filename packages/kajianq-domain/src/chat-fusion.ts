import type { Chunk } from "@app/rag-core";

/**
 * The pure half of the retriever: Reciprocal Rank Fusion (spec §3.3, k=60) and
 * the hierarchy bonuses. Split out of `chat-retriever.ts` for the 300-line
 * agentic cap — that module is the wiring (`RetrieverStore`/`RetrieverEmbedder`
 * in, `Retriever` out); this one is the arithmetic the fused path and its
 * tests read. No state, no store, no effects.
 *
 * (The metadata-filter mapping that used to live here moved to
 * `chat-filter-policy.ts`, which owns the store-facing side of the same stage
 * — including the loud failure the mapping owes a dimension it cannot
 * express.)
 */
/** RRF constant (spec §3.3: k=60). */
export const RRF_K = 60;

/**
 * Hierarchy bonus magnitudes (spec §3.3 item 4): Quran +0.3, Sahih +0.25,
 * Hasan +0.15, Kitab +0.1, and Principle +0.2 **on an analogy question**. The
 * Principle bonus is the only one that depends on what was asked rather than
 * on what the chunk is — see {@link hierarchyBonus}.
 */
export const HIERARCHY_BONUS = {
  quran: 0.3,
  sahih: 0.25,
  hasan: 0.15,
  kitab: 0.1,
  principleOnAnalogy: 0.2,
} as const;
/** One track's hit: the chunk plus its 1-based dense rank in that search. */
export type TrackHit = { chunk: Chunk; rank: number };
/**
 * Fuse per-search hit lists with RRF(k=60) plus hierarchy bonuses.
 * Exported for tests: pure, deterministic.
 *
 * **The order is total** (review A3 of the #274 fix round): equal scores are
 * broken by chunk id, so two runs over the same hit lists produce the same
 * sequence. Score ties are real — duplicate or near-identical verses are common
 * in this corpus, and two chunks can occupy mirrored ranks — and without the
 * tie-break the order fell back to `Map` insertion order, i.e. to the hit
 * lists' order, which the ANN search does not guarantee for equal distances.
 * The retriever's caller-order-is-priority-order contract (ADR-0049) and the
 * neighbour cap that truncates on it both rest on this being a total order.
 *
 * The remaining determinism limit is upstream and is a revisit trigger in
 * ADR-0049: the similarity query is ordered by the vector distance alone,
 * because a second `ORDER BY` key would cost the HNSW index scan. `rank_dense`
 * among exactly-equal distances can therefore differ between runs, and the
 * scores with it. This sort makes the most of the ranks it is given; it cannot
 * make the ranks themselves total.
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
    .sort((a, b) => b.score - a.score || compareChunkIds(a.chunk.id, b.chunk.id))
    .map((e) => ({
      ...e.chunk,
      score: e.score,
      rankDense: Math.min(...e.ranks),
    }));
}

/**
 * Byte-order comparison of two chunk ids — the tie-break above. Deliberately
 * not `localeCompare`: the order must not depend on the runtime's locale or
 * ICU data, or "same input, same order" would hold on one deployment and not
 * another.
 */
function compareChunkIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Hierarchy bonus from a chunk's opaque metadata (spec §3.3 item 4 magnitudes).
 *
 * Four bonuses are properties of the chunk — Quran, the two trustworthy hadith
 * grades, Kitab. The fifth is a property of the **question**: a Principle
 * chunk is boosted only when the question is an analogy (`intent: "analogy"`),
 * because a Principle is the *evidence* of an analogy — the case a new ruling
 * is measured against — and on a factual question the same chunk is commentary
 * and must not outrank a direct dalil. `intent` is opaque here: the engine and
 * this function never interpret it beyond equality with the caller's label.
 */
export function hierarchyBonus(chunk: Chunk, intent?: string): number {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  const sourceType = meta["sourceType"];
  let bonus = 0;
  if (sourceType === "quran") bonus += HIERARCHY_BONUS.quran;
  if (sourceType === "kitab") bonus += HIERARCHY_BONUS.kitab;
  if (sourceType === "principle" && intent === "analogy") {
    bonus += HIERARCHY_BONUS.principleOnAnalogy;
  }
  const grade = meta["grade"];
  if (grade === "sahih") bonus += HIERARCHY_BONUS.sahih;
  if (grade === "hasan") bonus += HIERARCHY_BONUS.hasan;
  return bonus;
}
