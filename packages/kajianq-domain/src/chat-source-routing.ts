import { entriesToFilters, filterEntries } from "./chat-filter-policy";
import type { KajianQFilters, RoutableSource } from "./filters";
import type { Intent, PrincipleTag, SubjectArea } from "./taxonomy";

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
 * The rules, and what each is for:
 *
 * | reading                                   | sources selected            |
 * | ----------------------------------------- | --------------------------- |
 * | `category: quran`                          | `quran`                     |
 * | `category: hadith`                        | `hadith`                    |
 * | `category: tafsir`                        | `quran`, `tafsir`           |
 * | `category: fikih`                          | `quran`, `hadith`, `kitab`  |
 * | `intent: analogy`, or a Principle is needed | adds `principle`          |
 * | no subject area settled                   | none — every source         |
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
 * Selecting a source is deliberately **not** the same as filtering by a
 * Principle tag: the tag filter is the model's classification applied as
 * metadata (`principle_tags ANY …`, the Principle Index at #16), while the
 * source selection is which index to read. They are set independently, so a
 * trace reader can tell "we searched the Principle Index for the yusr lens"
 * from "the question is about the Quran".
 */

/** What source routing reads off the router's classification. */
export type SourceRoutingInput = {
  intent: Intent;
  category?: SubjectArea;
  needsPrinciple: boolean;
  /** The Principle tags the reply named, already narrowed to the vocabulary. */
  principleTags: readonly PrincipleTag[];
  /** The filter hints the reply gave and the caller's overrides. */
  filters: KajianQFilters;
};

/**
 * The sources a subject area is answered from, in the authority order
 * (Quran → Hadith → Tafsir → Kitab). An unlisted area is not routed: the
 * question never settled what it is about, and picking sources for it would
 * narrow the corpus on a guess.
 */
const CATEGORY_SOURCES: Partial<Record<SubjectArea, readonly RoutableSource[]>> = {
  quran: ["quran"],
  hadith: ["hadith"],
  // Tafsir is commentary *on* the Quran, so the Quran is searched with it.
  tafsir: ["quran", "tafsir"],
  // A ruling question: Quran, then Sunnah, then the works carrying the
  // madzhab reasoning. Breadth here is the authority order spent as coverage.
  fikih: ["quran", "hadith", "kitab"],
};

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

/** The source types this reading is answered from; empty = no restriction. */
export function sourceTypesOf(input: SourceRoutingInput): readonly RoutableSource[] {
  const selected: RoutableSource[] = [...(CATEGORY_SOURCES[input.category ?? "general"] ?? [])];
  // A lens is only reachable from the Principle Index — the "why" question's
  // evidence — so needing one selects that source. `analogy` implies a lens
  // whether or not the reply said so (a qiyas answer is a Principle's case).
  if (input.needsPrinciple || input.intent === "analogy") selected.push("principle");
  return selected;
}

/**
 * The routing decision projected onto the trace — **the same filter record
 * retrieval receives**, produced by the same mapping, so the decision the
 * trace publishes and the search that runs cannot disagree. Throws
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
