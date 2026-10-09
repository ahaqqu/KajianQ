/**
 * KajianQ retrieval filter dimensions — the domain vocabulary the domain pack
 * supplies to the engine's generic `Query<TFilters>` (CONTEXT.md: Madzhab,
 * Grade, Matn/Sharh, Principle). Re-exported from the pack's barrel so chat
 * stages and callers share one type.
 *
 * **Every dimension is a set** (spec §3.3 item 3: `source_type`, `madzhab`,
 * `grade IN …`, `principle_tags ANY …`). A one-value dimension is a one-element
 * set, so the store's `metadata->>key = ANY($n::text[])` mapping in
 * `chat-filter-policy.ts` is the single shape every dimension takes — there is
 * no second, single-valued spelling that could quietly disagree with it.
 */

import type { PrincipleTag } from "./taxonomy";

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
 * the corpus does not carry yet (`principle` is the Principle Index, #16;
 * `kitab` is the classical-works corpus) so routing, the filter map and the
 * presentation order read one list rather than three.
 */
export const ROUTABLE_SOURCES = ["quran", "hadith", "tafsir", "kitab", "principle"] as const;
export type RoutableSource = (typeof ROUTABLE_SOURCES)[number];

/**
 * Retrieval metadata filters supplied to the engine's Query.filters. The
 * engine threads them through untouched; only this pack names the dimensions.
 *
 * A dimension that is absent — or present as an empty list — constrains
 * nothing. A dimension carrying a value the store cannot express is a typed
 * failure, never a dropped key: see `chat-filter-policy.ts`.
 */
export type KajianQFilters = {
  /** Source types to search; empty = every source. Selects the index. */
  sourceType?: readonly RoutableSource[];
  madzhab?: readonly Madzhab[];
  /** Spec §3.3 item 3's `grade IN …` — the grades a hadith may carry. */
  grade?: readonly Grade[];
  textLayer?: readonly TextLayer[];
  /** Spec §3.3 item 3's `principle_tags ANY …` (Principle Index, #16). */
  principleTags?: readonly PrincipleTag[];
};

/**
 * Every filter dimension and the `doc_children.metadata` key it binds to.
 *
 * **Exhaustive on purpose.** This is the one place a dimension is declared
 * *and* mapped, so a dimension added to {@link KajianQFilters} and forgotten
 * here is a typecheck failure rather than a filter that silently never reaches
 * the store. The keys are the corpus's own spellings (`sourceType`), not the
 * spec's prose spellings (`source_type`); the spec names the concept, the
 * stored key is what the SQL binds.
 */
export const FILTER_DIMENSIONS: Record<keyof KajianQFilters, string> = {
  sourceType: "sourceType",
  madzhab: "madzhab",
  grade: "grade",
  textLayer: "textLayer",
  principleTags: "principleTags",
};
