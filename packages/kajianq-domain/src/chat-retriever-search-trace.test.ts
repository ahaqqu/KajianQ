import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { RunContext, type Chunk } from "@app/rag-core";
import { createKajianQRetriever } from "./chat-retriever";
import type { KajianQFilters } from "./filters";
import {
  CALLER_PRIORITY_ORIGIN,
  SEARCH_HITS_TRACE_LIMIT,
  hierarchyBonus,
  rrfFuse,
  type MetadataFilterValue,
  type RetrieverStore,
} from "./chat-retriever-parts";
import { routedQuery } from "./test-utils/routed-query";

/**
 * The raw per-search trace record: one `search_hits` event per sub-query ×
 * track search, carrying the leading ids and dense ranks that search returned.
 * The fused `retrieval` event cannot say whether a row was never returned or
 * was dropped after the search, so this record is the evidence that separates
 * them — and it must not change what retrieval returns.
 */

const cost = { modelId: "m", tokensIn: 1, tokensOut: 1, latencyMs: 1, costMicroUsd: 1 };

type ChildRow = {
  id: string;
  textAr: string;
  textId: string | null;
  metadata: Record<string, unknown>;
};

type SearchOptions = Parameters<RetrieverStore["similaritySearch"]>[2];

const HADITH = { sourceType: "hadith", collection: "ibnmajah" } as const;

const child = (id: string): ChildRow => ({
  id,
  textAr: `arab-${id}`,
  textId: `id-${id}`,
  metadata: { ...HADITH },
});

/** `count` rows whose search order (and therefore dense rank) is their index. */
const rows = (prefix: string, count: number): ChildRow[] =>
  Array.from({ length: count }, (_, i) => child(`${prefix}${i + 1}`));

type SearchCall = {
  track: "primary" | "fallback";
  limit: number;
  filters: Record<string, MetadataFilterValue> | undefined;
};

function makeStore(
  rowsFor: (
    track: "primary" | "fallback",
    filters: Record<string, MetadataFilterValue> | undefined,
  ) => ChildRow[],
) {
  const calls: SearchCall[] = [];
  const store = {
    similaritySearch: (
      track: "primary" | "fallback",
      _embedding: readonly number[],
      o: SearchOptions,
    ) => {
      calls.push({ track, limit: o.limit, filters: o.filters });
      // `storeFilters({})` is an empty record, so either shape means unfiltered.
      const filtered = o.filters !== undefined && Object.keys(o.filters).length > 0;
      const found = rowsFor(track, filtered ? o.filters : undefined);
      return Effect.succeed(
        found.map((row, i) => ({ child: row, distance: 0.1 + i / 100, rankDense: i + 1 })),
      );
    },
    listDocChildNeighboursByChildIds: () => Effect.succeed([]),
  };
  return { store, calls };
}

type SubQuery = { text: string; role?: string; origin?: string };

const SUB_QUERIES: SubQuery[] = [
  { text: "apa keutamaan menuntut ilmu", role: "factual", origin: "rule" },
  { text: "hadith tentang ilmu", role: "dalil", origin: "model" },
];

type Recorded = { kind: string; detail?: unknown };

function run(
  store: unknown,
  record: (event: unknown) => void,
  subQueries: SubQuery[] = SUB_QUERIES,
  filters: KajianQFilters = {},
): Promise<Chunk[]> {
  const retriever = createKajianQRetriever({
    store: store as never,
    embedder: {
      embed: ({ texts }) => Effect.succeed({ vectors: texts.map(() => [0.1, 0.2]), cost }),
    },
    bridge: ((e: unknown) => Effect.runPromise(e as never)) as never,
    limit: 10,
  });
  return Effect.runPromise(
    Effect.provideService(
      retriever.retrieve(routedQuery("apa keutamaan menuntut ilmu", { subQueries, filters })),
      RunContext,
      { config: {}, now: () => 1, record } as never,
    ) as never,
  ) as Promise<Chunk[]>;
}

type SearchEvent = {
  detail: {
    role?: string;
    origin?: string;
    track: string;
    hits: number;
    topHits: { id: string; rankDense: number }[];
  };
};

const searchEvents = (recorded: Recorded[]): SearchEvent[] =>
  recorded.filter((event) => event.kind === "search_hits") as unknown as SearchEvent[];

/** The id/rank list a search returned, in its own order. */
const top = (prefix: string, count = SEARCH_HITS_TRACE_LIMIT) =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i + 1}`, rankDense: i + 1 }));

describe("the retriever records every sub-query × track search", () => {
  it("carries the identity, track, full count, and the leading ids with their ranks", async () => {
    const recorded: Recorded[] = [];
    const { store } = makeStore((track) =>
      rows(track === "primary" ? "p" : "f", track === "primary" ? 8 : 7),
    );
    await run(store, (event) => recorded.push(event as Recorded));

    expect(searchEvents(recorded).map((event) => event.detail)).toEqual([
      {
        role: "factual",
        origin: "rule",
        track: "primary",
        hits: 8,
        topHits: top("p", 8),
      },
      {
        role: "factual",
        origin: "rule",
        track: "fallback",
        hits: 7,
        topHits: top("f", 7),
      },
      {
        role: "dalil",
        origin: "model",
        track: "primary",
        hits: 8,
        topHits: top("p", 8),
      },
      {
        role: "dalil",
        origin: "model",
        track: "fallback",
        hits: 7,
        topHits: top("f", 7),
      },
    ]);
  });

  it("records ids and ranks only — never the chunk text or its metadata", async () => {
    const recorded: Recorded[] = [];
    const { store } = makeStore(() => rows("p", 8));
    await run(store, (event) => recorded.push(event as Recorded));

    const [event] = searchEvents(recorded);
    // The detail's shape is the privacy boundary: a future field carrying the
    // chunk (text or metadata) would show up here and in the serialized event.
    expect(Object.keys(event?.detail ?? {}).sort()).toEqual([
      "hits",
      "origin",
      "role",
      "topHits",
      "track",
    ]);
    expect(Object.keys(event?.detail.topHits[0] ?? {}).sort()).toEqual(["id", "rankDense"]);
    const serialized = JSON.stringify(searchEvents(recorded));
    expect(serialized).not.toContain("arab-");
    expect(serialized).not.toContain("id-p");
    expect(serialized).not.toContain("collection");
  });

  it("records a search that returned nothing as hits 0 with an empty list", async () => {
    const recorded: Recorded[] = [];
    const { store } = makeStore(() => []);
    await run(store, (event) => recorded.push(event as Recorded), [SUB_QUERIES[0]!]);

    const events = searchEvents(recorded);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.detail)).toEqual([
      { role: "factual", origin: "rule", track: "primary", hits: 0, topHits: [] },
      { role: "factual", origin: "rule", track: "fallback", hits: 0, topHits: [] },
    ]);
  });

  it("records the effective search once per track when relaxation probed before it", async () => {
    const recorded: Recorded[] = [];
    // The inferred filter matches nothing; only the unfiltered retry returns rows.
    const { store, calls } = makeStore((_track, filters) =>
      filters === undefined ? rows("c", 3) : [],
    );
    await run(
      store,
      (event) => recorded.push(event as Recorded),
      [{ text: "apa keutamaan menuntut ilmu", role: "factual", origin: "rule" }],
      { sourceType: ["principle"] },
    );

    // Probes are `filter_relaxed` events, not per-search records: the record is
    // the search that fed fusion, one per sub-query × track.
    expect(recorded.filter((event) => event.kind === "filter_relaxed")).toHaveLength(1);
    const events = searchEvents(recorded);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.detail.hits).toBe(3);
      expect(event.detail.topHits).toEqual(top("c", 3));
    }
    // Two searches for primary (filtered, then the adopted unfiltered retry) and
    // one for fallback, which inherits the drop for the run.
    expect(calls.map((call) => call.track)).toEqual(["primary", "primary", "fallback"]);
  });

  it("records a search's rows in dense-rank order, not the adapter's array order", async () => {
    // The seam promises no array order, so the same ten rows come back shuffled
    // with `rankDense` stating the ranks. The record must be ranks 1..10 in
    // order: a position-based record would present rank 7 as the leading row
    // while fusion — which sums ranks, not positions — returned the same chunks.
    const shuffled = [7, 2, 10, 1, 5, 9, 3, 8, 4, 6].map((rankDense) => ({
      row: child(`r${rankDense}`),
      rankDense,
    }));
    const store = {
      similaritySearch: (track: "primary" | "fallback") =>
        Effect.succeed(
          track === "primary"
            ? shuffled.map(({ row, rankDense }) => ({ child: row, distance: 0.1, rankDense }))
            : [],
        ),
      listDocChildNeighboursByChildIds: () => Effect.succeed([]),
    };

    const recorded: Recorded[] = [];
    await run(store, (event) => recorded.push(event as Recorded), [SUB_QUERIES[0]!]);

    const [primary] = searchEvents(recorded);
    expect(primary?.detail.hits).toBe(SEARCH_HITS_TRACE_LIMIT);
    expect(primary?.detail.topHits).toEqual(
      Array.from({ length: SEARCH_HITS_TRACE_LIMIT }, (_, i) => ({
        id: `r${i + 1}`,
        rankDense: i + 1,
      })),
    );
  });
});

/**
 * The observation must be just that: the returned chunks are byte-identical
 * whether the run's sink keeps the per-search events or discards them, and the
 * sink itself adds no store read and no embed call.
 */
describe("the per-search record does not change retrieval", () => {
  it("returns byte-identical chunks with the event kept and with it discarded", async () => {
    const kept: Recorded[] = [];
    const keptRun = await run(
      makeStore((track) => rows(track === "primary" ? "p" : "f", 6)).store,
      (event) => kept.push(event as Recorded),
    );
    const discardedRun = await run(
      makeStore((track) => rows(track === "primary" ? "p" : "f", 6)).store,
      () => {},
    );

    expect(kept.filter((event) => event.kind === "search_hits")).toHaveLength(4);
    expect(keptRun.map((chunk) => chunk.id)).toEqual(discardedRun.map((chunk) => chunk.id));
    expect(JSON.stringify(keptRun)).toBe(JSON.stringify(discardedRun));
  });

  it("issues no additional store read and no additional embed call", async () => {
    const recorded: Recorded[] = [];
    const { store, calls } = makeStore((track) => rows(track === "primary" ? "p" : "f", 4));
    let embedCalls = 0;
    let embeddedTexts: readonly string[] = [];
    const retriever = createKajianQRetriever({
      store: store as never,
      embedder: {
        embed: ({ texts }) => {
          embedCalls += 1;
          embeddedTexts = texts;
          return Effect.succeed({ vectors: texts.map(() => [0.1, 0.2]), cost });
        },
      },
      bridge: ((e: unknown) => Effect.runPromise(e as never)) as never,
      limit: 10,
    });
    await Effect.runPromise(
      Effect.provideService(
        retriever.retrieve(routedQuery("apa keutamaan menuntut ilmu", { subQueries: SUB_QUERIES })),
        RunContext,
        {
          config: {},
          now: () => 1,
          record: (event: unknown) => recorded.push(event as Recorded),
        } as never,
      ) as never,
    );

    expect(embedCalls).toBe(1);
    expect(embeddedTexts).toEqual(SUB_QUERIES.map((sub) => sub.text));
    expect(calls).toHaveLength(SUB_QUERIES.length * 2);
    expect(calls.every((call) => call.limit === 10)).toBe(true);
  });
});

const SAHIH = { sourceType: "hadith", collection: "bukhari", grade: "sahih" } as const;
const QURAN = { sourceType: "quran", surah: 1 } as const;
const KITAB = { sourceType: "kitab", collection: "adab" } as const;
const PRINCIPLE = { sourceType: "principle" } as const;

/** A row with metadata of its own, so the hierarchy bonus is exercised. */
const rankedRow = (id: string, metadata: Record<string, unknown> = HADITH): ChildRow => ({
  id,
  textAr: `arab-${id}`,
  textId: `id-${id}`,
  metadata,
});

type RankedRow = { row: ChildRow; rankDense: number };
type SearchHits = { primary: RankedRow[]; fallback: RankedRow[] };

/**
 * Non-uniform on purpose: different counts per track and per sub-query, ids
 * shared across tracks and sub-queries, and rows carrying all five hierarchy
 * bonuses — so a dropped list, a doubled score or a lost rank moves a number.
 */
const ORACLE_HITS: SearchHits[] = [
  {
    primary: [
      { row: rankedRow("a1", SAHIH), rankDense: 1 },
      { row: rankedRow("a2", QURAN), rankDense: 2 },
      { row: rankedRow("a3", KITAB), rankDense: 3 },
      { row: rankedRow("b1", PRINCIPLE), rankDense: 4 },
      { row: rankedRow("a4"), rankDense: 5 },
      { row: rankedRow("a5"), rankDense: 6 },
    ],
    fallback: [
      { row: rankedRow("a2", QURAN), rankDense: 1 },
      { row: rankedRow("b1", PRINCIPLE), rankDense: 2 },
      { row: rankedRow("b2", SAHIH), rankDense: 3 },
      { row: rankedRow("a4"), rankDense: 4 },
    ],
  },
  {
    primary: [
      { row: rankedRow("b2", SAHIH), rankDense: 1 },
      { row: rankedRow("a1", SAHIH), rankDense: 2 },
      { row: rankedRow("c1", QURAN), rankDense: 3 },
      { row: rankedRow("c2"), rankDense: 4 },
      { row: rankedRow("b1", PRINCIPLE), rankDense: 5 },
    ],
    fallback: [
      { row: rankedRow("a1", SAHIH), rankDense: 1 },
      { row: rankedRow("c1", QURAN), rankDense: 2 },
      { row: rankedRow("b3", KITAB), rankDense: 3 },
    ],
  },
];

/** The intent that turns the Principle chunk's bonus on, so all five bonuses count. */
const ORACLE_INTENT = "analogy";

/** The oracle's store double: hits are selected by sub-query (its vector) × track. */
function oracleStore() {
  return {
    similaritySearch: (
      track: "primary" | "fallback",
      embedding: readonly number[],
      _opts: SearchOptions,
    ) => {
      const sub = (embedding[0] ?? 0) - 1;
      const found = ORACLE_HITS[sub]?.[track] ?? [];
      return Effect.succeed(
        found.map(({ row: foundRow, rankDense }, i) => ({
          child: foundRow,
          distance: 0.1 + i / 100,
          rankDense,
        })),
      );
    },
    listDocChildNeighboursByChildIds: () => Effect.succeed([]),
    // The fixture carries Quran rows, so the short-surah completion arm reads;
    // it returns nothing, keeping the fused set the only source of chunks.
    listDocChildrenByParentSourceKey: () => Effect.succeed([]),
  };
}

/** One run over the oracle fixture; the sink keeps every event. */
async function runOracle() {
  const recorded: Recorded[] = [];
  const retriever = createKajianQRetriever({
    store: oracleStore() as never,
    embedder: {
      // A distinct vector per sub-query is what lets the double answer per search.
      embed: ({ texts }) => Effect.succeed({ vectors: texts.map((_, i) => [i + 1, 0]), cost }),
    },
    bridge: ((e: unknown) => Effect.runPromise(e as never)) as never,
    limit: SEARCH_HITS_TRACE_LIMIT,
  });
  const chunks = (await Effect.runPromise(
    Effect.provideService(
      retriever.retrieve(
        routedQuery("apa keutamaan menuntut ilmu", {
          subQueries: SUB_QUERIES,
          intent: ORACLE_INTENT,
        }),
      ),
      RunContext,
      {
        config: {},
        now: () => 1,
        record: (event: unknown) => recorded.push(event as Recorded),
      } as never,
    ) as never,
  )) as Chunk[];
  return { chunks, events: searchEvents(recorded) };
}

/**
 * The differential oracle. The store double returns a known list per
 * sub-query × track, the sink keeps every event, and the expected fusion is
 * built from the events themselves with the retriever's own bonus function.
 * Fusion scores a hit independently of which list carries it, so rebuilding the
 * events as one single-hit list per hit reproduces the same numbers as
 * production's one list per search. Ids **and** scores are compared, so a
 * doubled or lost list changes the assertion even where the id order does not;
 * and the fixture is non-uniform, so dropping any one sub-query's lists changes
 * the numbers.
 */
describe("the fused set is the pure fusion of the searches it recorded", () => {
  it("reproduces the events' own hit lists, ids and scores alike", async () => {
    const { chunks, events } = await runOracle();

    // Every search returned at most the store's bound, so each event carries its
    // whole list: the events are the fusion's input, not a sample of it.
    expect(events).toHaveLength(SUB_QUERIES.length * 2);
    for (const event of events) expect(event.detail.topHits).toHaveLength(event.detail.hits);

    const rowById = new Map<string, ChildRow>();
    for (const perSub of ORACLE_HITS) {
      for (const found of [...perSub.primary, ...perSub.fallback]) {
        rowById.set(found.row.id, found.row);
      }
    }
    const chunkOf = (id: string): Chunk => {
      const found = rowById.get(id);
      if (!found) throw new Error(`an event recorded an id the fixture never returned: ${id}`);
      return { id, text: found.textAr, metadata: found.metadata };
    };
    const listsOf = (chosen: readonly SearchEvent[]) =>
      chosen.flatMap((event) =>
        event.detail.topHits.map((hit) => [{ chunk: chunkOf(hit.id), rank: hit.rankDense }]),
      );
    const expected = rrfFuse(listsOf(events), (chunk) => hierarchyBonus(chunk, ORACLE_INTENT));
    const byId = (rows: readonly Chunk[]) =>
      [...rows]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map(({ id, score, rankDense }) => ({ id, score, rankDense }));

    // The returned set is fusion's set — same rows, same scores, same dense
    // ranks. The caller-priority guarantee leads the set (ADR-0062), so
    // membership is compared order-insensitively and the lead is asserted next.
    expect(byId(chunks)).toEqual(byId(expected));
    // The caller sub-query's top three hit rows: its primary rank 1 and 2 and the
    // fallback rank 2, in rank order with ties broken by id.
    expect(chunks.slice(0, 3).map((chunk) => chunk.id)).toEqual(["a1", "a2", "b1"]);
    expect(chunks.slice(0, 3).every((chunk) => chunk.origin === CALLER_PRIORITY_ORIGIN)).toBe(true);

    // The fixture is discriminating: dropping any one sub-query's lists changes
    // the fusion, so a run that consumed fewer searches than its record shows
    // cannot pass. Production records a sub-query's two tracks back to back.
    for (let sub = 0; sub < SUB_QUERIES.length; sub += 1) {
      const own = events.slice(sub * 2, sub * 2 + 2);
      expect(own.map((event) => event.detail.track)).toEqual(["primary", "fallback"]);
      const dropped = rrfFuse(listsOf(events.filter((event) => !own.includes(event))), (chunk) =>
        hierarchyBonus(chunk, ORACLE_INTENT),
      );
      expect(dropped.map((chunk) => [chunk.id, chunk.score])).not.toEqual(
        expected.map((chunk) => [chunk.id, chunk.score]),
      );
    }
  });
});
