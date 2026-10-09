import { describe, expect, it } from "vitest";
import { metadataFilters } from "./chat-filter-policy";
import { routeFilters, sourceRoutingDetail, sourceTypesOf } from "./chat-source-routing";
import type { SourceRoutingInput } from "./chat-source-routing";

/**
 * **Smart Router stage 3** (spec §3.3 item 3, CONTEXT.md "Smart Router"): the
 * rules that turn a reading into an index selection, and the projection of that
 * decision onto the trace.
 *
 * The property under test is not "the table is right" — the table is a product
 * decision with a published justification (`SPECS.md` §2.2, the usul authority
 * order) — but that **the decision is made by rules rather than by the model,
 * is complete (a settled category always selects something), and is what the
 * trace and the search both read**. The trap: `category: "fikih"` selects three
 * sources at once, so a rule that returned only the first (or an empty set for
 * an unrouted area) would still answer *something* and be invisible.
 */

const reading = (overrides: Partial<SourceRoutingInput> = {}): SourceRoutingInput => ({
  intent: "ruling",
  needsPrinciple: false,
  principleTags: [],
  filters: {},
  ...overrides,
});

describe("source routing reads the subject area into an index selection", () => {
  it.each([
    ["quran", ["quran"]],
    ["hadith", ["hadith"]],
    // Commentary goes with the text it explains.
    ["tafsir", ["quran", "tafsir"]],
    // A ruling question spends the authority order as breadth: Quran first,
    // then the Sunnah, then the works carrying the madzhab reasoning.
    ["fikih", ["quran", "hadith", "kitab"]],
  ] as const)("routes a %s question to %j", (category, expected) => {
    expect(sourceTypesOf(reading({ category }))).toEqual(expected);
  });

  it("selects NO source for an area no rule covers", () => {
    // `aqidah`/`sejarah`/`general`/no category: the question never settled what
    // it is about, so restricting the corpus on a guess would narrow it
    // silently. An empty selection is a decision and is recorded as one.
    for (const category of ["aqidah", "tasawuf", "sejarah", "adab", "general"] as const) {
      expect(sourceTypesOf(reading({ category }))).toEqual([]);
    }
    expect(sourceTypesOf(reading())).toEqual([]);
  });

  it("adds the Principle Index when a lens is needed, and on an analogy", () => {
    // The lens is only reachable from the Principle Index, so needing one
    // selects it. An analogy implies a lens whether or not the reply said so:
    // a qiyas answer measures a new case against a Principle.
    expect(sourceTypesOf(reading({ category: "fikih", needsPrinciple: true }))).toEqual([
      "quran",
      "hadith",
      "kitab",
      "principle",
    ]);
    expect(sourceTypesOf(reading({ intent: "analogy", category: "fikih" }))).toEqual([
      "quran",
      "hadith",
      "kitab",
      "principle",
    ]);
    expect(sourceTypesOf(reading({ intent: "aqidah" }))).toEqual([]);
  });
});

describe("routeFilters decides, the reply only hints", () => {
  it("carries the reply's own hints through as the sets the store binds", () => {
    expect(routeFilters(reading({ filters: { madzhab: ["syafii"], grade: ["sahih"] } }))).toEqual({
      madzhab: ["syafii"],
      grade: ["sahih"],
    });
  });

  it("sets the source selection and the Principle tags the reply named", () => {
    expect(
      routeFilters(reading({ category: "hadith", needsPrinciple: true, principleTags: ["yusr"] })),
    ).toEqual({
      sourceType: ["hadith", "principle"],
      principleTags: ["yusr"],
    });
  });

  it("never overrules the caller's explicit selection", () => {
    // A caller who names sources gets them: stage 3 refines a reading, it does
    // not contradict the person asking (the same rule the filter hints follow).
    expect(
      routeFilters(reading({ category: "fikih", filters: { sourceType: ["quran"] } })),
    ).toEqual({ sourceType: ["quran"] });
    // The tag filter and the source selection are independent dimensions: a
    // caller pinning the tags does not pin the index, so the lens still puts
    // the Principle Index in play.
    expect(
      routeFilters(reading({ needsPrinciple: true, filters: { principleTags: ["dharar"] } })),
    ).toEqual({ principleTags: ["dharar"], sourceType: ["principle"] });
  });

  it("does not invent a tag filter from a lens that has no tags", () => {
    // `needsPrinciple` with no tags selects the source but filters no tag: an
    // empty `principleTags` filter would demand a tag nobody named.
    const filters = routeFilters(reading({ category: "fikih", needsPrinciple: true }));
    expect(filters.principleTags).toBeUndefined();
    expect(filters.sourceType).toEqual(["quran", "hadith", "kitab", "principle"]);
  });
});

describe("the decision the trace publishes is the record retrieval runs with", () => {
  it("projects the same filter record the retriever maps", () => {
    const filters = routeFilters(
      reading({ category: "fikih", needsPrinciple: true, principleTags: ["yusr"] }),
    );
    const detail = sourceRoutingDetail(filters);
    expect(detail.sources).toEqual(["quran", "hadith", "kitab", "principle"]);
    // One mapping, two readers — the trace entry cannot disagree with the SQL.
    expect(detail.filters).toEqual(metadataFilters(filters));
  });

  it("records an EMPTY source list rather than omitting the decision", () => {
    // "Every source was in play" must not read the same as "nothing recorded".
    expect(sourceRoutingDetail({})).toEqual({ sources: [], filters: {} });
  });

  it("fails at the stage that decided, before any search runs", () => {
    // The invariant's loud half: an unexpressible dimension surfaces here, so
    // the run fails instead of answering a question the route did not choose.
    expect(() => sourceRoutingDetail({ source_type: ["quran"] } as never)).toThrow(
      /unknown_dimension/,
    );
  });
});
