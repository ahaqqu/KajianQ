import type { SubQuery } from "@app/rag-core";
import { entriesToFilters, filterEntries } from "./chat-filter-policy";
import type { KajianQFilters, RoutableSource } from "./filters";
import type { Intent, PrincipleTag, SubjectArea, SubQueryRole } from "./taxonomy";

/**
 * Smart Router stage 3: source routing — the rules that turn the router's
 * reading into the index selection and the metadata filters retrieval runs with.
 *
 * Deterministic and rule-based on purpose: which sources may answer a question is
 * a product decision with a published justification (the usul authority order,
 * `SPECS.md` §2.2), and a model that gets it wrong narrows the corpus silently.
 * The model may *hint* categories and filters; this module decides.
 *
 * The invariant this module owns is **route-wide coverage**: the sources a route
 * searches cover every part the route decomposed — the union of what the route's
 * Query category implies and what **every Sub-query's own role** implies, so a
 * multi-part question cannot be starved of a source one of its own parts asked for.
 * A source the selection omits is unreachable (`metadata->>sourceType = ANY(…)`),
 * so the omission is a silent failure nothing but this rule notices.
 *
 * Coverage over the *reading* is the second half of that invariant: the category
 * is a sampled classification, so a row may not leave a source the question's own
 * evidence needs out of reach on one sample and in reach on another. The scriptural
 * areas therefore share one breadth ({@link SCRIPTURAL_SOURCES}), and every
 * non-empty row selects the Sunnah — which of the scriptural areas a reading
 * settles cannot decide whether hadith evidence is searched at all.
 *
 * Both maps are `Record`s over the vocabulary that owns them, so a vocabulary value
 * added without a decision here is a typecheck failure rather than a silent
 * omission; a role this module cannot express throws
 * {@link SourceRoleNotExpressibleError} instead of contributing nothing quietly.
 *
 * An **empty category selection stays empty**, so a role may add to it but never
 * turn "every source" into a filter; and selecting a source is **not** filtering by
 * a Principle tag — the tag filter is the model's classification, the selection is
 * which index to read, and a trace reader must tell them apart.
 */

export type SourceRoutingInput = {
  intent: Intent;
  category?: SubjectArea;
  needsPrinciple: boolean;
  /** The Principle tags the reply named, already narrowed to the vocabulary. */
  principleTags: readonly PrincipleTag[];
  filters: KajianQFilters;
  /**
   * The parts retrieval will actually fan out over — `decomposeQuery`'s output,
   * not the reply's raw list — because the union must cover the decomposition the
   * route runs. Required, so a route cannot derive filters from a different set
   * than the search uses.
   */
  subQueries: readonly SubQuery[];
};

/**
 * The scriptural breadth: what a question about the Quran is answered from.
 *
 * The Quran, its commentary, and the Sunnah that carries the practice the
 * question asks about — **one** set shared by both scriptural areas, because
 * which of the two a reading settles is a distinction the evidence does not
 * draw. Rows that share it cannot be split without one of them dropping the
 * Sunnah from reach on a sampled label, so the sharing is the invariant, not
 * two equal-looking rows kept in sync by hand.
 */
const SCRIPTURAL_SOURCES = ["quran", "tafsir", "hadith"] as const;

/** The sources a subject area is answered from, in the authority order (Quran → Hadith → Tafsir → Kitab); an empty row is a decision, not a gap. */
const CATEGORY_SOURCES: Readonly<Record<SubjectArea, readonly RoutableSource[]>> = {
  quran: SCRIPTURAL_SOURCES,
  // A hadith question's evidence is the Sunnah the question names.
  hadith: ["hadith"],
  // Commentary goes with the text it explains, and with the Sunnah, whose
  // evidence carries the "why is it recited" half of a commentary question.
  tafsir: SCRIPTURAL_SOURCES,
  // A ruling question: Quran, then Sunnah, then the works carrying the madzhab
  // reasoning — the authority order spent as breadth.
  fikih: ["quran", "hadith", "kitab"],
  aqidah: [],
  tasawuf: [],
  sejarah: [],
  adab: [],
  general: [],
};

/**
 * The sources one sub-query role implies, on top of the category's own set.
 * `factual` implies none — the category states what the question is about — while
 * `dalil` and `sanad` parts are the evidence the corpus carries as `hadith`, and a
 * `principle` part is the lens, reachable only from the Principle Index.
 */
const ROLE_SOURCES: Readonly<Record<SubQueryRole, readonly RoutableSource[]>> = {
  factual: [],
  dalil: ["hadith"],
  sanad: ["hadith"],
  principle: ["principle"],
};

export class SourceRoleNotExpressibleError extends Error {
  override readonly name = "SourceRoleNotExpressibleError";
  readonly role: string;
  readonly reason: "unknown_role";

  constructor(role: string) {
    super(`sub-query role ${JSON.stringify(role)} is not expressible: unknown_role`);
    this.role = role;
    this.reason = "unknown_role";
  }
}

/**
 * The sources one sub-query role implies. The mapping above is exhaustive over the
 * vocabulary that owns it, so a role this throws on was written outside it: a part
 * that must be searched cannot be left unmapped without answering a different
 * question.
 *
 * A boundary guard for direct callers: stage 2 narrows every model label through
 * `narrowRole` first, so the router cannot reach this.
 */
export function roleSources(role: string): readonly RoutableSource[] {
  if (!Object.hasOwn(ROLE_SOURCES, role)) throw new SourceRoleNotExpressibleError(role);
  return ROLE_SOURCES[role as SubQueryRole];
}

/**
 * Decide the filters retrieval runs with: the reply's hints plus this stage's
 * source selection and Principle tags. A dimension the caller set explicitly wins
 * — the router never overrules the person asking the question.
 */
export function routeFilters(input: SourceRoutingInput): KajianQFilters {
  const filters: KajianQFilters = { ...input.filters };
  const sources = sourceTypesOf(input);
  if (sources.length > 0 && filters.sourceType === undefined) filters.sourceType = sources;
  if (input.principleTags.length > 0 && filters.principleTags === undefined) {
    filters.principleTags = [...input.principleTags];
  }
  return filters;
}

/**
 * The source types this route searches: the category's own selection unioned with
 * every part's role-implied sources — route-wide coverage.
 *
 * An empty category selection is returned as it is: an unfiltered search already
 * covers every part, so a role can add to a selection but never turn "every source"
 * into a filter. First-implied order (category row, then each part, then the lens
 * rule) keeps two equal readings identical.
 */
export function sourceTypesOf(input: SourceRoutingInput): readonly RoutableSource[] {
  const category = input.category ?? "general";
  // An unlisted key and an empty row are one answer with one spelling: no filter.
  // Deliberately unlike `roleSources`, which throws — a role that must become a
  // filter has no safe default, an area no rule covers has nothing to widen.
  if (!Object.hasOwn(CATEGORY_SOURCES, category)) return [];
  const categorySources = CATEGORY_SOURCES[category];
  if (categorySources.length === 0) return [];
  const selected = new Set<RoutableSource>();
  for (const source of categorySources) selected.add(source);
  // Every part fans out too: a role may imply a source the category does not.
  for (const sub of input.subQueries) {
    if (sub.role === undefined) continue;
    for (const source of roleSources(sub.role)) selected.add(source);
  }
  // A lens is reachable only from the Principle Index, so needing one selects that
  // source; `analogy` implies a lens whether or not the reply said so.
  if (input.needsPrinciple || input.intent === "analogy") selected.add("principle");
  return [...selected];
}

/**
 * The routing decision projected onto the trace — what retrieval receives for
 * everything stage 3 derived, produced by the same mapping, so the trace and the
 * search cannot disagree. A caller-pinned dimension is carried verbatim by
 * `routeFilters` and normalized here (trim, dedupe, drop blanks); a dimension the
 * store cannot express throws `FilterNotExpressibleError` from the stage that
 * decided it, before a single search runs.
 */
export function sourceRoutingDetail(filters: KajianQFilters): {
  /** The selected source types; empty means every source was in play. */
  sources: string[];
  /**
   * The metadata filter record retrieval should run with, keyed as the store binds;
   * dimensions a run gives up are `filter_relaxed` events, not this record.
   */
  filters: Record<string, string[]>;
} {
  const entries = filterEntries(filters);
  const sourceType: keyof KajianQFilters = "sourceType";
  return {
    sources: [...(entries.find((entry) => entry.dimension === sourceType)?.values ?? [])],
    filters: entriesToFilters(entries),
  };
}
