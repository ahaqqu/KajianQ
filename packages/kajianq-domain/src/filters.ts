/**
 * KajianQ retrieval filter dimensions — the domain vocabulary the domain pack
 * supplies to the engine's generic `Query<TFilters>` (CONTEXT.md: Madzhab,
 * Grade, Matn/Sharh). Re-exported from the pack's barrel so chat stages and
 * callers share one type.
 */

/** One of the four Sunni legal schools (CONTEXT.md "Madzhab"). */
export const MADZHABS = ["hanafi", "maliki", "syafii", "hambali"] as const;
export type Madzhab = (typeof MADZHABS)[number];

/** Hadith authenticity classification (CONTEXT.md "Grade"). */
export type Grade = "mutawatir" | "sahih" | "hasan" | "dhaif";

/** Body of a work vs. commentary on it (CONTEXT.md "Matn"/"Sharh"). */
export type TextLayer = "matn" | "sharh";

/**
 * Retrieval metadata filters supplied to the engine's Query.filters. The
 * engine threads them through untouched; only this pack names the dimensions.
 */
export type KajianQFilters = {
  madzhab?: Madzhab;
  grade?: Grade;
  textLayer?: TextLayer;
};
