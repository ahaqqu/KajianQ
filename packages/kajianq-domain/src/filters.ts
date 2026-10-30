/**
 * KajianQ retrieval filter dimensions — the domain vocabulary the domain pack
 * supplies to the engine's generic `Query<TFilters>` (CONTEXT.md: Grade,
 * Source routing). Re-exported from the pack's barrel so chat stages and callers
 * share one type.
 *
 * **Only dimensions the corpus carries are filters.** Madzhab, TextLayer and
 * Principle stay in the router's vocabulary — the classification is trace
 * content — but no stored row carries their metadata keys, so they are not
 * filter dimensions: a route may not ask for a constraint the corpus cannot
 * satisfy.
 *
 * **Every dimension is a set** (spec §3.3 item 3 binds `sourceType` and `grade`
 * as exact value matches). A one-value dimension is a one-element set, so the
 * store's `metadata->>key = ANY($n::text[])` mapping in `chat-filter-policy.ts`
 * is the single shape every dimension takes — there is no second, single-valued
 * spelling that could quietly disagree with it.
 */

/** One of the four Sunni legal schools (CONTEXT.md "Madzhab"). */
export const MADZHABS = ["hanafi", "maliki", "syafii", "hambali"] as const;
export type Madzhab = (typeof MADZHABS)[number];

/** Hadith authenticity classification (CONTEXT.md "Grade"). */
export const GRADES = ["mutawatir", "sahih", "hasan", "dhaif"] as const;
export type Grade = (typeof GRADES)[number];

/** Body of a work vs. commentary on it (CONTEXT.md "Matn"/"Sharh"). */
export const TEXT_LAYERS = ["matn", "sharh"] as const;
export type TextLayer = (typeof TEXT_LAYERS)[number];

/**
 * The source types **source routing may select** among — the labels the
 * `sourceType` filter binds. Distinct from the per-ingester `SourceType`
 * (`quran-source.ts`), which is the single label one ingester writes onto its
 * rows: this is the closed set a route chooses from, and it names two sources
 * the corpus does not carry yet (`principle` is the Principle Index; `kitab`
 * is the classical-works corpus) so routing, the filter map and the
 * presentation order read one list rather than three.
 */
export const ROUTABLE_SOURCES = ["quran", "hadith", "tafsir", "kitab", "principle"] as const;
export type RoutableSource = (typeof ROUTABLE_SOURCES)[number];

/**
 * Retrieval metadata filters supplied to the engine's Query.filters. The
 * engine threads them through untouched; only this pack names the dimensions.
 *
 * A dimension that is absent — or present as an empty list — constrains
 * nothing. A dimension carrying a value the store cannot express — a retired
 * dimension included — is a typed failure, never a dropped key: see
 * `chat-filter-policy.ts`.
 */
export type KajianQFilters = {
  /** Source types to search; empty = every source. Selects the index. */
  sourceType?: readonly RoutableSource[];
  /** The grades a hadith may carry. */
  grade?: readonly Grade[];
  /**
   * The per-chain grades a hadith's transmission rows may carry (CONTEXT.md
   * "Isnad"). A child matches when **any** of its chains carries one of the
   * grades; the filter selects the child, never one of its chains, so every
   * consumer presenting the evidence receives every row — a `sahih` filter on a
   * child that also carries a dhaif chain still surfaces that dhaif chain.
   */
  chainGrade?: readonly Grade[];
  /**
   * The narrator ids a hadith's transmission rows must include. Identity, not a
   * name spelling: the catalogue's resolved ids, supplied by a caller that
   * resolved a name through the store's own name read.
   */
  narratorId?: readonly string[];
};

/**
 * How one filter dimension reaches the store.
 *
 * - `metadata` — a `doc_children.metadata` key, bound as
 *   `metadata->>key = ANY(values)`.
 * - `chainGrade` / `narratorId` — a **relation** clause over the transmission
 *   rows attached to the child, which the store expresses as a fixed `EXISTS`
 *   clause on its allowlisted column. These carry no metadata key at all, so
 *   their record key is the dimension's own name: a relation dimension can never
 *   collide with a metadata key (`grade` is a metadata key; `chainGrade` is not).
 */
export type FilterBinding =
  | { readonly on: "metadata"; readonly key: string }
  | { readonly on: "chainGrade" }
  | { readonly on: "narratorId" };

/**
 * Every filter dimension and how it reaches the store.
 *
 * **Exhaustive on purpose.** This is the one place a dimension is declared
 * *and* mapped, so a dimension added to {@link KajianQFilters} and forgotten
 * here is a typecheck failure rather than a filter that silently never reaches
 * the store. The metadata keys are pinned to the keys ingestion actually writes
 * by a test beside this module: a dimension added without data fails there
 * rather than matching nothing. The keys are the corpus's own spellings
 * (`sourceType`), not the spec's prose spellings (`source_type`); the spec
 * names the concept, the stored key is what the SQL binds. A relation dimension
 * is pinned to the row the seam's chain read returns instead, in the same test.
 */
export const FILTER_DIMENSIONS: Record<keyof KajianQFilters, FilterBinding> = {
  sourceType: { on: "metadata", key: "sourceType" },
  grade: { on: "metadata", key: "grade" },
  chainGrade: { on: "chainGrade" },
  narratorId: { on: "narratorId" },
};

/**
 * The record key one dimension binds — the metadata key it maps to, or the
 * dimension's own name for a relation clause. The relaxation trace is written in
 * this key space, so `intended − dropped` reconstructs the record a search ran.
 */
export function storeKeyOf(dimension: keyof KajianQFilters): string {
  const binding = FILTER_DIMENSIONS[dimension];
  return binding.on === "metadata" ? binding.key : dimension;
}

/**
 * The relation column a store-record key stands for, or `null` when the key is a
 * metadata key. The one place the record's key space is read back into the
 * store's clause grammar, so a relation dimension cannot be bound as a metadata
 * key by a caller that never learned the difference.
 */
export function relationOf(recordKey: string): "grade" | "narratorIds" | null {
  if (recordKey === storeKeyOf("chainGrade")) return "grade";
  if (recordKey === storeKeyOf("narratorId")) return "narratorIds";
  return null;
}
