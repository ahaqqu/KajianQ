import { Effect } from "effect";
import { describe, expect, it } from "vitest";
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
 * **Smart Router stage 3** (spec §3.3 item 3, CONTEXT.md "Smart Router"): the
 * rules that turn a reading into an index selection, and the projection of that
 * decision onto the trace.
 *
 * The invariant under test is **route-wide coverage**: *the sources a route
 * searches cover every part the route decomposed* — the source selection is the
 * union of what the route's Query category implies and what every Sub-query's
 * own role implies, and it is the record the trace publishes and the search
 * receives. The failure it guards is silent by construction: a source the filter
 * omits is unreachable (`metadata->>sourceType = ANY(…)`), yet the run still
 * answers — or refuses — with every trace field individually correct, so
 * nothing but the coverage rule itself notices. `gs-v0-015` is the measured case:
 * a `tafsir` route whose own third sub-query asked for the hadith on reciting
 * Al-Fatihah, searched Quran + tafsir only, and over-refused.
 *
 * The trap: an unlisted category selects **no** filter — the broadest possible
 * search — so a naive union would turn that into a filter (`general` + one
 * `sanad` part ⇒ hadith only) and *narrow* the corpus where the change was meant
 * to widen it. An unlisted category therefore stays unfiltered, and a part's
 * role can only widen a selection the category already made.
 */

const reading = (overrides: Partial<SourceRoutingInput> = {}): SourceRoutingInput => ({
  intent: "ruling",
  needsPrinciple: false,
  principleTags: [],
  filters: {},
  subQueries: [],
  ...overrides,
});

/** One decomposed part, as the route hands it over. */
const part = (text: string, role?: string) => ({
  text,
  ...(role !== undefined ? { role } : {}),
});

describe("source routing reads the subject area into an index selection", () => {
  it.each([
    ["quran", ["quran"]],
    ["hadith", ["hadith"]],
    // Commentary goes with the text it explains — and with the Sunnah, whose
    // evidence carries the "why is it recited" half of a commentary question
    // (ADR-0052; the route cannot always say that through a role).
    ["tafsir", ["quran", "tafsir", "hadith"]],
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

  it("keeps an area outside the vocabulary unfiltered, not a crash", () => {
    // "Unlisted keeps no filter" must hold on every path, not only the router's:
    // a row whose decision is empty and a key the vocabulary does not carry are
    // the same answer with one spelling. The router cannot pass the second
    // (`readRouterReply` narrows through `isSubjectArea`), but this function is
    // exported and the base sha returned `[]` for it — a direct caller must not
    // be the one input that turns a route into a `TypeError` (review A5 of the
    // #438 fix round).
    expect(sourceTypesOf(reading({ category: "zikr" as never }))).toEqual([]);
    expect(
      sourceTypesOf(reading({ category: "zikr" as never, subQueries: [part("h", "dalil")] })),
    ).toEqual([]);
  });

  it("keeps an unlisted category unfiltered — a part's role can only widen a filter, never create one", () => {
    // The trap this decision must not fall into: `general` yields no filter at
    // all (the broadest possible search), so a naive union would turn that into
    // a filter — `general` + one `sanad` part would search hadith only and
    // quietly lose the Quran coverage it had. An unfiltered route already covers
    // every part by definition, so the union adds nothing to it and may not
    // remove anything either.
    expect(
      sourceTypesOf(reading({ category: "general", subQueries: [part("h", "sanad")] })),
    ).toEqual([]);
    expect(sourceTypesOf(reading({ subQueries: [part("h", "dalil")] }))).toEqual([]);
    // The lens rule is the same kind of implication and follows the same rule:
    // a lens filter on an unrouted category was the same narrowing by another
    // route (and probed away on today's corpus, the Principle Index being #16).
    expect(sourceTypesOf(reading({ category: "general", needsPrinciple: true }))).toEqual([]);
    expect(
      sourceTypesOf(reading({ intent: "analogy", subQueries: [part("p", "principle")] })),
    ).toEqual([]);
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

describe("route-wide coverage: the category's sources union every part's own role", () => {
  it("searches the hadith the route's own part asked for — the gs-v0-015 shape", () => {
    // The measured failure, as the router's own reply shaped it: the category
    // reads `tafsir` and the reply's third sub-query asks for the hadith on
    // reciting Al-Fatihah, labelled `dalil` — the role the staging traces carry
    // (trace `b432098d`, trace `5e7840f8`; issue #435). On the base sha the filter
    // excluded every hadith row by construction, the run over-refused, and the
    // trace showed a correct-looking route.
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
    // Each role's implication, isolated from the category's own selection.
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
    // `factual` is the one role that implies no source *of its own*: it is the
    // question itself, and the category is the route's statement of what that
    // question is about. A mapping that invented a source here would filter
    // every route on a guess.
    expect(
      sourceTypesOf(reading({ category: "quran", subQueries: [part("q", "factual")] })),
    ).toEqual(["quran"]);
  });

  it("publishes the union as the record retrieval is handed, from one derivation", () => {
    // The traceability bind: if the union happened after this mapping the trace
    // would lie. Both halves come from the same `routeFilters` output.
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
    // The mapping is `Record<SubQueryRole, …>`, so a role added without a source
    // mapping is a typecheck failure; this is the runtime half, reddening if the
    // map is ever loosened. `roleSources` throws on a role it cannot express, so
    // a vocabulary value with no row cannot pass silently as "no sources".
    for (const role of SUB_QUERY_ROLES) {
      expect(() => roleSources(role), `no source mapping for role "${role}"`).not.toThrow();
    }
  });

  it("fails loudly on a role it cannot express, where that role must become a filter", () => {
    // A role outside the vocabulary cannot be narrowed away into "contributes
    // nothing": with a category that has a selection, its part would be searched
    // under the wrong filter and the run would answer a different question than
    // the route decomposed. Same style as the filter map's
    // `FilterNotExpressibleError`: typed, named value, stable reason.
    expect(() => roleSources("hadits")).toThrow(/unknown_role/);
    expect(() =>
      sourceTypesOf(reading({ category: "tafsir", subQueries: [part("h", "hadits")] })),
    ).toThrow(/hadits/);
  });

  it("does not fail on a role it never has to express", () => {
    // Under an unlisted category there is no filter to derive — every source is
    // already in play — so an unmappable label costs no coverage and must not
    // turn a serveable question into a failed run. The guard fires where a role
    // would have to add a source, not on a label nothing asks anything of.
    expect(
      sourceTypesOf(reading({ category: "general", subQueries: [part("h", "hadits")] })),
    ).toEqual([]);
  });

  it("covers a role-less hadith part from the tafsir row — the dropped-label route", () => {
    // The covered half of the residual, pinned where it is the only thing that
    // can carry the part: stage 2 drops a model label outside the vocabulary
    // (`narrowRole`), so the part arrives here with no role at all and the union
    // skips it (`if (sub.role === undefined) continue`), leaving the widened
    // `tafsir` row as its sole coverage. That is the third staging run's route —
    // "the third carries no roles" — and the reason the row ships alongside the
    // union, so narrowing the row back must redden here (review C1 of the #438
    // fix round). The labelled shape stays the loud-failure case above: a part
    // whose role must become a filter cannot be silently unmapped.
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
    // A caller who names sources gets them: stage 3 refines a reading, it does
    // not contradict the person asking (the same rule the filter hints follow).
    expect(
      routeFilters(reading({ category: "fikih", filters: { sourceType: ["quran"] } })),
    ).toEqual({ sourceType: ["quran"] });
    // The tag filter and the source selection are independent dimensions: a
    // caller pinning the tags does not pin the index, so the lens still puts
    // the Principle Index in play — on a category the rules did settle, where
    // there is a selection for the lens to widen.
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

    // The coupling, asserted across the seam instead of against the mapping
    // that produced the value: the REAL retriever's first store call must carry
    // the record the trace published. `expect(detail.filters).toEqual(
    // metadataFilters(filters))` could not fail — the projection IS that call —
    // so it pinned nothing.
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
    // "Every source was in play" must not read the same as "nothing recorded".
    expect(sourceRoutingDetail({})).toEqual({ sources: [], filters: {} });
  });

  it("normalizes the sources it publishes from the same entries as the record", () => {
    // One `filterEntries` pass produces both halves, so a caller value the store
    // would simply not bind — blank, untidy, duplicated — is absent from the
    // published `sources` too. Reading them from the raw array instead let a
    // blank reach the contract's `minLength(1)` and fail the run at its END,
    // after the spend, rather than at the router that decided (A5).
    expect(
      sourceRoutingDetail({ sourceType: ["quran", "", " quran ", "hadith"] } as never),
    ).toEqual({ sources: ["quran", "hadith"], filters: { sourceType: ["quran", "hadith"] } });
  });

  it("fails at the stage that decided, before any search runs", () => {
    // The invariant's loud half: an unexpressible dimension surfaces here, so
    // the run fails instead of answering a question the route did not choose.
    expect(() => sourceRoutingDetail({ source_type: ["quran"] } as never)).toThrow(
      /unknown_dimension/,
    );
  });
});
