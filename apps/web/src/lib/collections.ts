import { COLLECTION_AVAILABLE } from "./collections-available";
import { COLLECTION_PLANNED_KITAB, COLLECTION_PLANNED_CORPORA } from "./collections-planned-kitab";
import { COLLECTION_PLANNED_SOURCES } from "./collections-planned-sources";
import {
  COLLECTION_CATEGORIES,
  filterByCategory,
  byStatus,
  type CollectionCategory,
  type CollectionEntry,
  type CollectionFilter,
  type CollectionStatus,
  type Localized,
} from "./collections-types";

/**
 * The collection page's content: the typed data module the CollectionPage
 * renders, mirroring the repository's register of sources. The markdown
 * register is never imported at runtime (a production bundle cannot read repo
 * files), so the sibling data modules are the content and this module is the
 * single aggregation point. What they mirror, and must be kept true to:
 *
 *   - `NOTICES/DATASETS.md` — the attribution register. Licenses and full
 *     upstream wording live there; an available entry carries only a one-line
 *     attribution note here, never a duplicated license paragraph.
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

export {
  COLLECTION_CATEGORIES,
  filterByCategory,
  byStatus,
  type CollectionCategory,
  type CollectionEntry,
  type CollectionFilter,
  type CollectionStatus,
  type Localized,
};

/** Every entry, available first — the order the page renders. */
export const COLLECTION_ENTRIES: readonly CollectionEntry[] = [
  ...COLLECTION_AVAILABLE,
  ...COLLECTION_PLANNED_KITAB,
  ...COLLECTION_PLANNED_CORPORA,
  ...COLLECTION_PLANNED_SOURCES,
];
