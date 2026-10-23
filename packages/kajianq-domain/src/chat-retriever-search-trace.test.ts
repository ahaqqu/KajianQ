import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { RunContext, type Chunk } from "@app/rag-core";
import { createKajianQRetriever } from "./chat-retriever";
import type { KajianQFilters } from "./filters";
import {
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
        topHits: top("p"),
      },
      {
        role: "factual",
        origin: "rule",
        track: "fallback",
        hits: 7,
        topHits: top("f"),
      },
      {
        role: "dalil",
        origin: "model",
        track: "primary",
        hits: 8,
        topHits: top("p"),
      },
      {
        role: "dalil",
        origin: "model",
        track: "fallback",
        hits: 7,
        topHits: top("f"),
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
});

/**
 * The observation must be just that. The two proofs below: the returned chunks
 * are byte-identical whether the run's sink keeps the per-search events or
 * discards them, and they are exactly the pure fusion of the same searches.
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

  it("returns exactly the pure RRF fusion of the searches it recorded", async () => {
    const primary = rows("p", 6);
    const fallback = rows("f", 4);
    const { store } = makeStore((track) => (track === "primary" ? primary : fallback));
    const chunks = await run(store, () => {});

    const chunkOf = (row: ChildRow) => ({
      id: row.id,
      text: row.textAr,
      metadata: row.metadata,
    });
    const expected = rrfFuse(
      [
        primary.map((row, i) => ({ chunk: chunkOf(row), rank: i + 1 })),
        fallback.map((row, i) => ({ chunk: chunkOf(row), rank: i + 1 })),
      ],
      (chunk) => hierarchyBonus(chunk),
    );

    expect(chunks.map((chunk) => [chunk.id, chunk.rankDense])).toEqual(
      expected.map((chunk) => [chunk.id, chunk.rankDense]),
    );
  });
});
