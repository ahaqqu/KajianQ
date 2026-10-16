import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { RunContext } from "@app/rag-core";
import { createKajianQRetriever } from "./chat-retriever";
import {
  routeFilters,
  roleSources,
  sourceRoutingDetail,
  sourceTypesOf,
} from "./chat-source-routing";
import type { SourceRoutingInput } from "./chat-source-routing";
import { SUB_QUERY_ROLES } from "./taxonomy";
import { routedQuery } from "./test-utils/routed-query";

const cost = { modelId: "m", tokensIn: 1, tokensOut: 1, latencyMs: 1, costMicroUsd: 1 };

/**
 * **Smart Router stage 3**: the rules that turn a reading into an index
 * selection, and the projection of that decision onto the trace.
 *
 * The invariant under test is **route-wide coverage**: the source selection is
 * the union of what the route's category implies and what every sub-query's role
 * implies — the record the trace publishes and the search receives. A source the
 * filter omits is unreachable (`metadata->>sourceType = ANY(…)`).
 *
 * The trap: an unlisted category selects **no** filter — the broadest possible
 * search — so a naive union would narrow the corpus where coverage is meant to
 * widen it. An unlisted category stays unfiltered, and a part's role can only
 * widen a selection the category already made.
 */

const reading = (overrides: Partial<SourceRoutingInput> = {}): SourceRoutingInput => ({
  intent: "ruling",
  needsPrinciple: false,
  principleTags: [],
  filters: {},
  subQueries: [],
  ...overrides,
});

const part = (text: string, role?: string) => ({
  text,
  ...(role !== undefined ? { role } : {}),
});

describe("source routing reads the subject area into an index selection", () => {
  it.each([
    ["quran", ["quran"]],
    ["hadith", ["hadith"]],
    // Commentary goes with the text it explains, and with the Sunnah, whose
    // evidence carries the "why is it recited" half of a commentary question.
    ["tafsir", ["quran", "tafsir", "hadith"]],
    // A ruling question spends the authority order as breadth: Quran, Sunnah,
    // then the works carrying the madzhab reasoning.
    ["fikih", ["quran", "hadith", "kitab"]],
  ] as const)("routes a %s question to %j", (category, expected) => {
    expect(sourceTypesOf(reading({ category }))).toEqual(expected);
  });

  it("selects NO source for an area no rule covers", () => {
    // An area the question never settled — `aqidah`/`sejarah`/`general`/none —
    // must not be narrowed on a guess; an empty selection is recorded as one.
    for (const category of ["aqidah", "tasawuf", "sejarah", "adab", "general"] as const) {
      expect(sourceTypesOf(reading({ category }))).toEqual([]);
    }
    expect(sourceTypesOf(reading())).toEqual([]);
  });

  it("keeps an area outside the vocabulary unfiltered, not a crash", () => {
    // "Unlisted keeps no filter" holds on every path, not only the router's: an
    // empty decision and a key the vocabulary does not carry are the same answer
    // with one spelling. The router cannot pass the second, but this function is
    // exported — a direct caller must not be the one input that turns a route
    // into a `TypeError`.
    expect(sourceTypesOf(reading({ category: "zikr" as never }))).toEqual([]);
    expect(
      sourceTypesOf(reading({ category: "zikr" as never, subQueries: [part("h", "dalil")] })),
    ).toEqual([]);
  });

  it("keeps an unlisted category unfiltered — a part's role can only widen a filter, never create one", () => {
    // A lens filter on an unrouted category is the same narrowing by another route.
    expect(
      sourceTypesOf(reading({ category: "general", subQueries: [part("h", "sanad")] })),
    ).toEqual([]);
    expect(sourceTypesOf(reading({ subQueries: [part("h", "dalil")] }))).toEqual([]);
    expect(sourceTypesOf(reading({ category: "general", needsPrinciple: true }))).toEqual([]);
    expect(
      sourceTypesOf(reading({ intent: "analogy", subQueries: [part("p", "principle")] })),
    ).toEqual([]);
  });

  it("adds the Principle Index when a lens is needed, and on an analogy", () => {
    // The lens is only reachable from the Principle Index, so needing one selects
    // it; an analogy implies a lens whether or not the reply said so.
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

describe("route-wide coverage: the category's sources union every part's own role", () => {
  it("searches the hadith the route's own part asked for — the gs-v0-015 shape", () => {
    const filters = routeFilters(
      reading({
        intent: "comparison",
        category: "tafsir",
        subQueries: [
          part("makna Surah Al-Fatihah", "factual"),
          part("mengapa dibaca dalam setiap salat", "factual"),
          part("hadith no prayer for one who does not recite Al-Fatihah", "dalil"),
        ],
      }),
    );
    expect(filters.sourceType).toEqual(["quran", "tafsir", "hadith"]);
  });

  it("puts a role's source in play under a category that names neither", () => {
    for (const [role, source] of [
      ["sanad", "hadith"],
      ["dalil", "hadith"],
      ["principle", "principle"],
    ] as const) {
      expect(
        sourceTypesOf(reading({ category: "quran", subQueries: [part("q", role)] })),
        `a ${role} part must put ${source} in play`,
      ).toContain(source);
    }
  });

  it("adds nothing for a factual part — the category is what the factual part is about", () => {
    // `factual` implies no source *of its own*: the category says what the
    // question is about, so inventing one here would filter every route.
    expect(
      sourceTypesOf(reading({ category: "quran", subQueries: [part("q", "factual")] })),
    ).toEqual(["quran"]);
  });

  it("publishes the union as the record retrieval is handed, from one derivation", () => {
    // The traceability bind: both halves come from one `routeFilters` output.
    const filters = routeFilters(
      reading({ category: "tafsir", subQueries: [part("q", "factual"), part("h", "sanad")] }),
    );
    expect(sourceRoutingDetail(filters)).toEqual({
      sources: ["quran", "tafsir", "hadith"],
      filters: { sourceType: ["quran", "tafsir", "hadith"] },
    });
  });

  it("is deterministic: two derivations over equal readings give the same lists", () => {
    const readingOnce = () =>
      reading({
        intent: "analogy",
        category: "fikih",
        needsPrinciple: true,
        subQueries: [part("a", "sanad"), part("b", "factual"), part("c", "principle")],
      });
    expect(sourceTypesOf(readingOnce())).toEqual(sourceTypesOf(readingOnce()));
  });

  it("resolves every role the vocabulary declares", () => {
    // The mapping is `Record<SubQueryRole, …>`, so a missing row is a typecheck
    // failure; this runtime half throws rather than passing a value silently.
    for (const role of SUB_QUERY_ROLES) {
      expect(() => roleSources(role), `no source mapping for role "${role}"`).not.toThrow();
    }
  });

  it("fails loudly on a role it cannot express, where that role must become a filter", () => {
    // A role outside the vocabulary cannot be narrowed away into "contributes
    // nothing": its part would be searched under the wrong filter and the run
    // would answer a different question than the route decomposed.
    expect(() => roleSources("hadits")).toThrow(/unknown_role/);
    expect(() =>
      sourceTypesOf(reading({ category: "tafsir", subQueries: [part("h", "hadits")] })),
    ).toThrow(/hadits/);
  });

  it("does not fail on a role it never has to express", () => {
    // Under an unlisted category there is no filter to derive, so the guard fires
    // only where a role would have to add a source.
    expect(
      sourceTypesOf(reading({ category: "general", subQueries: [part("h", "hadits")] })),
    ).toEqual([]);
  });

  it("covers a role-less hadith part from the tafsir row — the dropped-label route", () => {
    // With no role the union skips the part (`narrowRole` drops a label outside
    // the vocabulary), leaving the widened `tafsir` row as its sole coverage:
    // narrowing that row back must redden here. A part whose role must become a
    // filter stays the loud-failure case above.
    expect(
      routeFilters(
        reading({ category: "tafsir", subQueries: [part("hadits tentang keutamaan ilmu")] }),
      ),
    ).toEqual({ sourceType: ["quran", "tafsir", "hadith"] });
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
    // A caller who names sources gets them: stage 3 refines a reading, never overrules it.
    expect(
      routeFilters(reading({ category: "fikih", filters: { sourceType: ["quran"] } })),
    ).toEqual({ sourceType: ["quran"] });
    // The tag filter and the source selection are independent dimensions: a
    // caller pinning the tags does not pin the index, so the lens still puts the
    // Principle Index in play.
    expect(
      routeFilters(
        reading({
          category: "quran",
          needsPrinciple: true,
          filters: { principleTags: ["dharar"] },
        }),
      ),
    ).toEqual({ principleTags: ["dharar"], sourceType: ["quran", "principle"] });
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
  it("hands the retriever the very record the trace published", async () => {
    const filters = routeFilters(
      reading({ category: "fikih", needsPrinciple: true, principleTags: ["yusr"] }),
    );
    const detail = sourceRoutingDetail(filters);
    expect(detail.sources).toEqual(["quran", "hadith", "kitab", "principle"]);

    // The coupling asserted across the seam: the REAL retriever's first store
    // call must carry the record the trace published.
    const calls: (Record<string, string | readonly string[]> | undefined)[] = [];
    const retriever = createKajianQRetriever({
      store: {
        similaritySearch: (
          _track: string,
          _embedding: readonly number[],
          o: { filters?: Record<string, string | readonly string[]> },
        ) => {
          calls.push(o.filters);
          return Effect.succeed([
            {
              child: { id: "c1", textAr: "نص", textId: null, metadata: {} },
              distance: 0.1,
              rankDense: 1,
            },
          ]);
        },
        listDocChildNeighboursByChildIds: () => Effect.succeed([]),
      } as never,
      embedder: { embed: () => Effect.succeed({ vectors: [[0.1, 0.2]], cost }) },
      bridge: ((e: unknown) => Effect.runPromise(e as never)) as never,
      limit: 5,
    });
    await Effect.runPromise(
      Effect.provideService(
        retriever.retrieve(routedQuery("apa hukumnya", { intent: "ruling", filters })) as never,
        RunContext,
        { config: {}, now: () => 1, record: () => {} } as never,
      ) as never,
    );

    expect(calls[0]).toEqual(detail.filters);
  });

  it("records an EMPTY source list rather than omitting the decision", () => {
    expect(sourceRoutingDetail({})).toEqual({ sources: [], filters: {} });
  });

  it("normalizes the sources it publishes from the same entries as the record", () => {
    // One `filterEntries` pass produces both halves, so a value the store would
    // not bind — blank, untidy, duplicated — is absent from `sources` too.
    expect(
      sourceRoutingDetail({ sourceType: ["quran", "", " quran ", "hadith"] } as never),
    ).toEqual({ sources: ["quran", "hadith"], filters: { sourceType: ["quran", "hadith"] } });
  });

  it("fails at the stage that decided, before any search runs", () => {
    expect(() => sourceRoutingDetail({ source_type: ["quran"] } as never)).toThrow(
      /unknown_dimension/,
    );
  });
});
