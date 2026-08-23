/**
 * kajianq-domain — the KajianQ domain pack on top of the DARS engine.
 *
 * All Islamic-domain logic lives here (and in `apps/`), never in the engine
 * packages. This pack supplies the domain inputs the engine treats as opaque:
 * retrieval metadata filters, prompt templates (parameterized by language),
 * and the domain vocabulary of CONTEXT.md.
 *
 * Foundation skeleton: defines the domain vocabulary types injected into the
 * engine. Source parsers, prompt templates, and the terminology-graph
 * consumption arrive with the corpus and Smart Router tickets.
 */

/** One of the four Sunni legal schools (CONTEXT.md "Madzhab"). */
export const MADZHABS = ["hanafi", "maliki", "syafii", "hambali"] as const;
export type Madzhab = (typeof MADZHABS)[number];

/** Hadith authenticity classification (CONTEXT.md "Grade"). */
export const GRADES = ["mutawatir", "sahih", "hasan", "dhaif"] as const;
export type Grade = (typeof GRADES)[number];

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
