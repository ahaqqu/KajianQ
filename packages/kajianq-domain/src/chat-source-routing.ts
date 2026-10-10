import type { SubQuery } from "@app/rag-core";
import { entriesToFilters, filterEntries } from "./chat-filter-policy";
import type { KajianQFilters, RoutableSource } from "./filters";
import type { Intent, PrincipleTag, SubjectArea, SubQueryRole } from "./taxonomy";

/**
 * Smart Router **stage 3: source routing** (spec §3.3 item 3, CONTEXT.md "Smart
 * Router") — the rules that turn the router's reading into the index selection
 * and the metadata filters retrieval runs with.
 *
 * Deterministic and rule-based on purpose. The cheap-tier LLM's job is stages
 * 1–2 (what was asked, what to search for); *which sources may answer it* is a
 * product decision with a published justification — the usul authority order
 * (`SPECS.md` §2.2) — and a model that gets it wrong narrows the corpus
 * silently. So the model may *hint* categories and filters; this module
 * decides, and the decision is what the trace records.
 *
 * **The invariant this module owns is route-wide coverage:** *the sources a
 * route searches cover every part the route decomposed.* The selection is the
 * union of what the route's Query category implies and what **every Sub-query's
 * own role** implies, so a multi-part question cannot be starved of a source one
 * of its own parts asked for. A source the selection omits is unreachable
 * (`metadata->>sourceType = ANY(…)`), so the omission is a silent failure: the
 * run answers — or refuses — with the sub-query, its role and the filter each
 * individually correct on the trace, and nothing but this rule notices
 * (`gs-v0-015`: a `tafsir` route whose own part asked for the hadith on reciting
 * Al-Fatihah, searched Quran + tafsir, and over-refused).
 *
 * The rules, and what each is for:
 *
 * | reading                                   | sources selected            |
 * | ----------------------------------------- | --------------------------- |
 * | `category: quran`                          | `quran`                     |
 * | `category: hadith`                        | `hadith`                    |
 * | `category: tafsir`                        | `quran`, `tafsir`, `hadith` |
 * | `category: fikih`                          | `quran`, `hadith`, `kitab`  |
 * | a `factual` part                          | nothing of its own          |
 * | a `dalil` or `sanad` part                 | `hadith`                    |
 * | a `principle` part                        | `principle`                 |
 * | `intent: analogy`, or a Principle is needed | adds `principle`          |
 * | no subject area settled (empty selection)  | none — every source, and a |
 * |                                            | part's role cannot filter it |
 *
 * Both maps are `Record`s over the vocabulary that owns them, so a category or
 * a role added without a decision here is a typecheck failure rather than a
 * silent omission — the same construction as the filter map's own
 * `FILTER_DIMENSIONS`. A role value this module cannot express throws
 * {@link SourceRoleNotExpressibleError} where it would have to become a filter,
 * in the style of that map's `FilterNotExpressibleError`: typed and loud, never
 * a quiet "contributes nothing".
 *
 * `fikih` is the one place the authority order is spent as breadth: a ruling
 * question is answered from the Quran first, then the Sunnah, then the works
 * that carry the madzhab reasoning — so all three are searched and the
 * *presentation* order (the assembler) and the *authority* order (the system
 * prompt) arrange them afterwards. No category selects a source the corpus
 * does not carry in a way that could empty the search: an unsatisfiable
 * selection is dropped per dimension and recorded (the retriever's relaxation),
 * never silently ignored.
 *
 * An **empty category selection stays empty**: an area no rule covers has no
 * source claim to widen, and an unfiltered search already covers every part, so
 * role-implied sources (and the lens rule) may add to a selection but never turn
 * "every source" into a filter. A union taken over the roles alone would drop
 * every part whose role implies no source — the `factual` part, which *is* what
 * the category is about — and narrow the corpus on exactly the reading that
 * settled nothing.
 *
 * Selecting a source is deliberately **not** the same as filtering by a
 * Principle tag: the tag filter is the model's classification applied as
 * metadata (`principle_tags ANY …`, the Principle Index at #16), while the
 * source selection is which index to read. They are set independently, so a
 * trace reader can tell "we searched the Principle Index for the yusr lens"
 * from "the question is about the Quran".
 */

/** What source routing reads off the router's classification and decomposition. */
export type SourceRoutingInput = {
  intent: Intent;
  category?: SubjectArea;
  needsPrinciple: boolean;
  /** The Principle tags the reply named, already narrowed to the vocabulary. */
  principleTags: readonly PrincipleTag[];
  /** The filter hints the reply gave and the caller's overrides. */
  filters: KajianQFilters;
  /**
   * The parts retrieval will actually fan out over — `decomposeQuery`'s output,
   * not the reply's raw list — because the union must cover the decomposition
   * the route *runs*, repairs and ceiling included. Required: a route that skips
   * the decomposition cannot compile its way into a filter derived from a
   * different set than the search uses.
   */
  subQueries: readonly SubQuery[];
};

/**
 * The sources a subject area is answered from, in the authority order
 * (Quran → Hadith → Tafsir → Kitab). An empty row is a decision, not a gap: the
 * question never settled what it is about, and picking sources for it would
 * narrow the corpus on a guess.
 */
const CATEGORY_SOURCES: Readonly<Record<SubjectArea, readonly RoutableSource[]>> = {
  quran: ["quran"],
  hadith: ["hadith"],
  // Tafsir is commentary *on* the Quran, so the Quran is searched with it — and
  // the Sunnah too: "why is this recited / why does the practice hold" is a
  // commentary question whose evidence the corpus carries as hadith, and a route
  // that can only label its hadith part `factual` (the role vocabulary's blind
  // spot) would otherwise starve it. Breadth is the authority order spent as
  // coverage, the same trade `fikih` makes.
  tafsir: ["quran", "tafsir", "hadith"],
  // A ruling question: Quran, then Sunnah, then the works carrying the
  // madzhab reasoning. Breadth here is the authority order spent as coverage.
  fikih: ["quran", "hadith", "kitab"],
  aqidah: [],
  tasawuf: [],
  sejarah: [],
  adab: [],
  general: [],
};

/**
 * The sources one sub-query role implies, on top of the category's own set.
 *
 * `factual` is the one role that implies no source of its own — it is the
 * question itself, and the category is the route's statement of what that
 * question is about. The two evidence roles are where a multi-part question
 * reaches past its category: a `dalil` part is the proof for a ruling and a
 * `sanad` part is a hadith's chain and grade, and the corpus carries both as
 * `hadith`. A `principle` part is the lens, reachable only from the Principle
 * Index.
 */
const ROLE_SOURCES: Readonly<Record<SubQueryRole, readonly RoutableSource[]>> = {
  factual: [],
  dalil: ["hadith"],
  sanad: ["hadith"],
  principle: ["principle"],
};

/** A sub-query role this module cannot turn into a source selection. Loud, typed, never a drop. */
export class SourceRoleNotExpressibleError extends Error {
  override readonly name = "SourceRoleNotExpressibleError";
  /** The offending role, as the route wrote it. */
  readonly role: string;
  /** Why it cannot be expressed — a stable, short reason. */
  readonly reason: "unknown_role";

  constructor(role: string) {
    super(`sub-query role ${JSON.stringify(role)} is not expressible: unknown_role`);
    this.role = role;
    this.reason = "unknown_role";
  }
}

/**
 * The sources one sub-query role implies. The vocabulary is owned by
 * `SUB_QUERY_ROLES` and the mapping above is exhaustive over it, so a role this
 * throws on is one the caller wrote outside the vocabulary: a part that must be
 * searched cannot be left unmapped without answering a different question.
 *
 * A boundary guard for this module's direct callers, not a serving state the
 * router can reach: stage 2's decomposition narrows every model label through
 * `narrowRole` before the union reads it, so an out-of-vocabulary label leaves
 * its part role-less and covered by the category row alone (ADR-0052's residual).
 */
export function roleSources(role: string): readonly RoutableSource[] {
  if (!Object.hasOwn(ROLE_SOURCES, role)) throw new SourceRoleNotExpressibleError(role);
  return ROLE_SOURCES[role as SubQueryRole];
}

/**
 * Decide the filters retrieval runs with: the reply's hints plus this stage's
 * source selection and Principle tags. A dimension the caller set explicitly
 * always wins — the caller asked for it, and the router never overrules the
 * person asking the question.
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
 * The source types this route searches: the category's own selection unioned
 * with every part's role-implied sources — route-wide coverage, so the search
 * covers the decomposition the router made.
 *
 * An empty category selection is returned as it is: an area no rule covers has
 * no claim to widen, and an unfiltered search already covers every part, so a
 * role (or the lens rule) can add to a selection but can never turn "every
 * source" into a filter — and no role has to be expressed at all, so a label
 * this module cannot map is no coverage loss on an unfiltered route. The union is
 * in the order the sources are first implied — category row, then each part in
 * the decomposition's own order, then the lens rule — so two equal readings
 * publish identical lists.
 */
export function sourceTypesOf(input: SourceRoutingInput): readonly RoutableSource[] {
  const category = input.category ?? "general";
  // Two readings of "no rule covers this area" are one answer with one spelling:
  // a row whose decision is empty, and a key that is not in the vocabulary at
  // all, both keep no filter. The router can never pass the second — stage 2
  // narrows `category` through `isSubjectArea` — but this function is exported,
  // and the base read tolerated it (`?? []`); an unlisted key must not be the one
  // input that turns a route into a crash. Same `Object.hasOwn` guard as
  // `roleSources` below, so both reads of an unknown vocabulary value are guarded
  // (they differ in verdict on purpose: a role that must become a filter has no
  // safe default, an area no rule covers has nothing to widen).
  if (!Object.hasOwn(CATEGORY_SOURCES, category)) return [];
  const categorySources = CATEGORY_SOURCES[category];
  if (categorySources.length === 0) return [];
  const selected = new Set<RoutableSource>();
  for (const source of categorySources) selected.add(source);
  // Every part retrieval will fan out over: a role that implies a source the
  // category did not is exactly the part the category rule used to starve.
  for (const sub of input.subQueries) {
    if (sub.role === undefined) continue;
    for (const source of roleSources(sub.role)) selected.add(source);
  }
  // A lens is only reachable from the Principle Index — the "why" question's
  // evidence — so needing one selects that source. `analogy` implies a lens
  // whether or not the reply said so (a qiyas answer is a Principle's case).
  if (input.needsPrinciple || input.intent === "analogy") selected.add("principle");
  return [...selected];
}

/**
 * The routing decision projected onto the trace — **the record retrieval
 * receives for everything stage 3 derived**, produced by the same mapping, so
 * the decision the trace publishes and the search that runs cannot disagree
 * over what the rules decided (the router hands this same `routeFilters` output
 * to retrieval). The one exception is a dimension the caller pinned: `routeFilters`
 * carries it verbatim, while this projection is normalized (trim, dedupe, drop
 * blanks), so for that record the event publishes the normalized reading of what
 * the store binds — reachable through the seam, never from the wire, which
 * parses no filters. Throws
 * `FilterNotExpressibleError` for a dimension the store cannot express, from
 * the stage that decided it: the route fails before a single search runs,
 * rather than answering a question it did not choose.
 *
 * Both halves are read from one `filterEntries` pass, so the normalized filter
 * record and the selected sources cannot disagree either: `sources` carries the
 * same trimmed, deduplicated, blank-free values the store binds, and a caller
 * value the store would simply not bind fails here — at the router, before the
 * spend — instead of failing the contract at the end of the run.
 */
export function sourceRoutingDetail(filters: KajianQFilters): {
  /** The selected source types; empty means every source was in play. */
  sources: string[];
  /**
   * The metadata filter record the route decided retrieval should run with,
   * keyed as the store binds. A run may give dimensions up (the retriever's
   * relaxation) — those drops are `filter_relaxed` events, not this record.
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
