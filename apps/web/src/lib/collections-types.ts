/**
 * The collection page's content model. The page renders one
 * `CollectionEntry[]`; the data itself lives in the sibling
 * `collections-available.ts`, `collections-planned-kitab.ts` (which also
 * exports `COLLECTION_PLANNED_CORPORA`), and `collections-planned-sources.ts`
 * modules, aggregated by `collections.ts`.
 *
 * The markdown register is never imported at runtime (a production bundle
 * cannot read repo files), so the data modules mirror, and must be kept true to:
 *
 *   - `NOTICES/DATASETS.md` — the attribution register. Licenses and upstream
 *     wording live there; an available entry carries only a one-line note here,
 *     never a duplicated license paragraph.
 *   - `SPECS.md` §2.1 (capabilities), §4.1 (sources) and §4.2 (priority kitab).
 *   - Issues #21 and #22 (priority kitab), #24 (terminology concept graph),
 *     #33 and #35 (complete verified author corpora), #141 (staging hadith
 *     headroom within the free-plan cap), #27–#31 (Sanadset isnad v2).
 *   - ADR-0014 (license-safe concept-graph seed sources) and ADR-0026
 *     (fawazahmed0 source, dhaif-wins grade consolidation).
 *
 * The `available` vs `planned` split is the page's load-bearing claim: a
 * planned entry is registered work, never an ingest already done.
 */

/** A string per locale; the page renders the reader's locale. */
export type Localized = { en: string; id: string };

export type CollectionStatus = "available" | "planned";

/**
 * The filter tab an entry groups under. Values are stable ids; the tab labels
 * come from the `collectionFilter*` i18n keys, so tabs cannot drift from the
 * entries that carry them.
 */
export type CollectionCategory =
  | "scripture"
  | "hadith"
  | "tafsir"
  | "kitab"
  | "theology"
  | "spirituality"
  | "terminology";

export type CollectionEntry = {
  id: string;
  status: CollectionStatus;
  category: CollectionCategory;
  /**
   * Era or scope label shown under the title, e.g. "3rd c. AH · d. 256 H" or
   * "Revealed 610–632 CE" — the entry's own dating, not a fixed century.
   */
  century: Localized;
  title: Localized;
  author: Localized;
  description: Localized;
  /** One-line attribution for an available entry (see module comment). */
  attribution?: Localized;
  /**
   * The per-locale question the entry's "Ask about this source" affordance
   * links into the chat with (#175) — the entry's own copy, in both locales,
   * never a generic one. Available only, like `attribution`: a planned entry
   * is registered work, and linking it into an answer would imply a source the
   * corpus does not have.
   */
  ask?: Localized;
  /** A planned entry's registered reference, e.g. "#33" — shown as "planned · #33". */
  planRef?: string;
};

/** The visible filter tabs, in order; `all` is always rendered first. */
export const COLLECTION_CATEGORIES: readonly CollectionCategory[] = [
  "scripture",
  "hadith",
  "tafsir",
  "kitab",
  "theology",
  "spirituality",
  "terminology",
];

/** The active filter: one category, or every entry. */
export type CollectionFilter = CollectionCategory | "all";

/** Entries matching the filter (`all` matches everything), order preserved. */
export function filterByCategory(
  entries: readonly CollectionEntry[],
  filter: CollectionFilter,
): CollectionEntry[] {
  if (filter === "all") return [...entries];
  return entries.filter((entry) => entry.category === filter);
}

/** Entries with the given availability status, order preserved. */
export function byStatus(
  entries: readonly CollectionEntry[],
  status: CollectionStatus,
): CollectionEntry[] {
  return entries.filter((entry) => entry.status === status);
}
