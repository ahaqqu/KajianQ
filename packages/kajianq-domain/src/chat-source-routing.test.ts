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
import type { RoutableSource } from "./filters";
import { SUBJECT_AREAS, SUB_QUERY_ROLES, INTENTS, type SubQueryRole } from "./taxonomy";
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

/**
 * The role map's own expected rows, as an exhaustive record over the vocabulary:
 * a role added to `SUB_QUERY_ROLES` without an expectation here is a typecheck
 * failure, so the pin below cannot silently skip it.
 */
const ROLE_SOURCES_EXPECTED: Readonly<Record<SubQueryRole, readonly RoutableSource[]>> = {
  factual: [],
  dalil: ["hadith"],
  sanad: ["hadith"],
  principle: ["principle"],
};

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
    // The scriptural breadth: a question about the Quran is answered from the
    // Quran, its commentary and the Sunnah that carries its practice — one set
    // for both scriptural areas, so neither reading can drop the Sunnah.
    ["quran", ["quran", "tafsir", "hadith"]],
    ["hadith", ["hadith"]],
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

  it.each([...SUB_QUERY_ROLES])("maps the %s role to its own sources, and nothing else", (role) => {
    // Pinned on the role map itself, because a routing result cannot see most of
    // it: every non-empty category row already names the Sunnah, so a lost or
    // added `dalil`/`sanad` source changes no selection today, and only
    // `principle` is observable downstream. What this buys is the map's
    // declaration staying exactly as decided — a role widened or narrowed here is
    // a deliberate edit against this test rather than a silent one no reader sees.
    expect(roleSources(role)).toEqual(ROLE_SOURCES_EXPECTED[role]);
  });

  it("adds nothing for a factual part — the category is what the factual part is about", () => {
    // `factual` implies no source *of its own*: the category says what the
    // question is about, so inventing one here would filter every route. Asserted
    // under the `hadith` row, the narrowest non-empty row — every source type but
    // the Sunnah itself would show there as an addition.
    expect(
      sourceTypesOf(reading({ category: "hadith", subQueries: [part("q", "factual")] })),
    ).toEqual(["hadith"]);
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

/**
 * **The reading is sampled; the evidence is not.** The subject area is a model
 * output, so the same verbatim question can come back `quran` on one run and
 * `tafsir` on the next. The selection must cover the scriptural evidence the
 * shape of the question needs under **every** value the vocabulary declares —
 * which is why every case below is universally quantified over that vocabulary
 * instead of checked against the two labels one measurement happened to see.
 */
describe("the sampled reading cannot decide whether scriptural evidence is searched", () => {
  /** The two areas whose readings differ only in a distinction retrieval does not draw. */
  const SCRIPTURAL_AREAS = ["quran", "tafsir"] as const;

  it("selects the same sources for the two scriptural areas, for every intent, part and lens", () => {
    const roleSets = [
      [],
      ["factual"],
      ["dalil"],
      ["sanad"],
      ["principle"],
      ["factual", "dalil"],
      ["factual", "principle"],
    ] as const;
    for (const intent of INTENTS) {
      for (const needsPrinciple of [false, true]) {
        for (const roles of roleSets) {
          const selectionOf = (category: (typeof SCRIPTURAL_AREAS)[number]) =>
            sourceTypesOf(
              reading({
                category,
                intent,
                needsPrinciple,
                subQueries: roles.map((role, i) => part(`p${i}`, role)),
              }),
            );
          expect(
            selectionOf("quran"),
            `${intent} / needsPrinciple=${needsPrinciple} / ${roles.join("+") || "no part"}`,
          ).toEqual(selectionOf("tafsir"));
        }
      }
    }
  });

  it("never makes the Sunnah unreachable, for any area the vocabulary declares", () => {
    // An empty selection is the whole corpus, so it already reaches the Sunnah; a
    // non-empty one must name it. Nothing downstream restores the omission: the
    // filter hides those rows from every fused search — the one way back is a
    // zero-hit search's relaxation, which the run records as its own event.
    for (const category of SUBJECT_AREAS) {
      const sources = sourceTypesOf(reading({ category }));
      expect(
        sources.length === 0 || sources.includes("hadith"),
        `area ${category} makes the Sunnah unreachable: ${sources.join(",") || "(none)"}`,
      ).toBe(true);
    }
  });

  it("searches the Sunnah half of a whole-surah question under either scriptural reading", () => {
    // A surah named in the question, asked what it means and why it is recited:
    // the "why" is the practice's evidence, so both scriptural readings must
    // search the Sunnah — otherwise the answer and its recall flip with the sample.
    const shape = {
      subQueries: [
        part("makna Surah Al-Fatihah", "factual"),
        part("mengapa dibaca dalam setiap salat", "factual"),
      ],
    };
    for (const category of SCRIPTURAL_AREAS) {
      expect(routeFilters(reading({ ...shape, category })).sourceType).toEqual([
        "quran",
        "tafsir",
        "hadith",
      ]);
    }
  });
});

describe("the retriever's scope is the filter record, never the classification", () => {
  it("hands the store the same filters whatever reading produced the routed query", async () => {
    // Stage 3 decides the scope; the retriever only binds it. If the retriever
    // ever read the classification back — the category the trace carries — the
    // sampled-label dependence stage 3 closes would return through this seam.
    const filtersFor = async (intent: string, category: string) => {
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
          // The question names a surah, so ADR-0045's scope read runs too; it
          // reads by parent key and is not the scope under test.
          listDocChildrenByParentSourceKey: () => Effect.succeed([]),
        } as never,
        embedder: { embed: () => Effect.succeed({ vectors: [[0.1, 0.2]], cost }) },
        bridge: ((e: unknown) => Effect.runPromise(e as never)) as never,
        limit: 5,
      });
      const routed = routedQuery("apa makna Surah Al-Fatihah", {
        intent,
        filters: { sourceType: ["quran", "tafsir", "hadith"] },
        attributes: { category },
      });
      await Effect.runPromise(
        Effect.provideService(retriever.retrieve(routed) as never, RunContext, {
          config: {},
          now: () => 1,
          record: () => {},
        } as never) as never,
      );
      return calls;
    };
    expect(await filtersFor("factual", "quran")).toEqual(await filtersFor("comparison", "tafsir"));
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
    ).toEqual({
      principleTags: ["dharar"],
      sourceType: ["quran", "tafsir", "hadith", "principle"],
    });
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
