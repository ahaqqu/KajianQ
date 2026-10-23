import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  FILTER_DIMENSIONS,
  ROUTABLE_SOURCES,
  type KajianQFilters,
  type RoutableSource,
} from "./filters";
import {
  FilterNotExpressibleError,
  RELAXATION_ORDER,
  filterEntries,
  metadataFilters,
  nextRelaxation,
  storeFilters,
  type FilterEntry,
} from "./chat-filter-policy";
import { bundleQuranSources, quranSourceParser } from "./quran-ingest";
import { bundleHadithSources, hadithSourceParser } from "./hadith-ingest";

/**
 * **The routing invariant, at its narrowest point.**
 *
 * The trace publishes a routing decision — "these sources, these filters" —
 * and retrieval runs a SQL `WHERE metadata->>key = ANY(values)` built from it.
 * The two must be the same object, and every filter dimension must reach the
 * store. The silent failure this suite exists to catch: a dimension the router
 * *decided* can be *dropped* by the mapping with no compile error, no runtime
 * error, and nothing in the trace — the route then answers a different
 * question than the router chose, and no gate would notice.
 *
 * Two traps are named here before they are written:
 *
 * - **A dimension without corpus data.** The map is exhaustive over
 *   `KajianQFilters`, but the filter type alone cannot say whether the corpus
 *   carries the key: `madzhab`, `textLayer` and `principleTags` are classified
 *   by the router and stored by no row. The pin below runs the ingesters the
 *   corpus actually goes through and fails a dimension whose key they never
 *   write, so "filter the store cannot satisfy" fails here rather than silently
 *   matching nothing.
 * - **The snake_case near-miss.** The spec writes `source_type`; the corpus
 *   stores `sourceType`. A caller (or a future contributor reading only the
 *   spec) passing the spec's spelling must FAIL, not be quietly ignored — an
 *   ignored key is a widening of the search the decision did not ask for.
 * - **The unexpressible value.** The store binds strings and string arrays. A
 *   number, a nested object, or a `{ any: [...] }` operator shape cannot be
 *   bound; it must fail rather than be skipped, because skipping it narrows or
 *   widens retrieval silently.
 */

const sourceTypeEntry = (values: string): FilterEntry => ({
  dimension: "sourceType",
  key: "sourceType",
  values: [values],
});

describe("the dimension map is exhaustive over the filter type", () => {
  it("names a store key for every dimension of KajianQFilters", () => {
    // Compile-time half: `FILTER_DIMENSIONS` is a Record over every key, so a
    // dimension added to the type without a store key fails `bun run check`.
    // This is the runtime half — the two key sets are equal, not merely
    // overlapping, so a stale entry cannot outlive a removed dimension.
    const declared = Object.keys(FILTER_DIMENSIONS).sort();
    const samples: Required<KajianQFilters> = {
      sourceType: ["quran"],
      grade: ["sahih"],
    };
    expect(Object.keys(samples).sort()).toEqual(declared);
  });

  it.each([
    ["sourceType", "sourceType", { sourceType: ["quran"] }],
    ["grade", "grade", { grade: ["sahih", "hasan"] }],
  ] as const)("binds the %s dimension to its store key", (dimension, key, filters) => {
    expect(metadataFilters(filters)).toEqual({ [key]: filters[dimension as keyof typeof filters] });
  });

  it("carries a set-valued dimension through as a set, in declared order", () => {
    // Spec §3.3 item 3's `grade IN (…)`: several values must survive to the
    // store, not collapse to the first.
    const filters: KajianQFilters = {
      sourceType: ["quran", "hadith"],
      grade: ["mutawatir", "sahih", "hasan"],
    };
    expect(metadataFilters(filters)).toEqual({
      sourceType: ["quran", "hadith"],
      grade: ["mutawatir", "sahih", "hasan"],
    });
  });

  it("binds identical parameter lists for equal filters, whatever key order they were written in", () => {
    const a = metadataFilters({ grade: ["sahih"], sourceType: ["quran"] });
    const b = metadataFilters({ sourceType: ["quran"], grade: ["sahih"] });
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

/**
 * The filter map's contract with the corpus, executed rather than described:
 * run the same two ingesters production runs over the repo's real-source
 * fixtures and collect every metadata key they write. The forward pin is
 * one-directional on purpose — ingestion writes keys that are not filters
 * (`surah`, `collection`, `citation`, …), while every FILTER_DIMENSIONS entry
 * must be a key that exists. The retired set has its own reverse guard below,
 * so ingestion starting to write one of those keys is also a deliberate change.
 * Between them they partition the pack's filter vocabulary, so removing a live
 * dimension is as visible as restoring a retired one.
 */
const FIXTURES = resolve(import.meta.dirname, "fixtures");
const readFixture = (relative: string) => readFile(resolve(FIXTURES, relative), "utf8");

/**
 * Every dimension the pack's filter vocabulary declares, live or retired. The
 * two sets below must partition it, so either direction of retirement is an
 * edit to this committed list rather than a one-line change the corpus pins
 * cannot see.
 */
const FILTER_VOCABULARY = ["sourceType", "grade", "madzhab", "textLayer", "principleTags"] as const;

/** Dimensions the corpus cannot satisfy; they may return only when ingestion writes their keys. */
const RETIRED_FILTER_KEYS = ["madzhab", "textLayer", "principleTags"] as const;

describe("the live and retired sets name every declared dimension", () => {
  it("partitions the filter vocabulary between the live dimensions and the retired set", () => {
    const live: readonly string[] = Object.keys(FILTER_DIMENSIONS);
    const retired: readonly string[] = RETIRED_FILTER_KEYS;
    // Disjoint: no dimension is both a filter and retired.
    expect(live.filter((key) => retired.includes(key))).toEqual([]);
    // Total: deleting `grade` without retiring it, or restoring a retired key
    // without taking it off this list, leaves a dimension named by neither set
    // and fails here. Adding a dimension is a deliberate edit to all three.
    expect([...live, ...retired].sort()).toEqual([...FILTER_VOCABULARY].sort());
  });
});

async function ingestedMetadataKeys(): Promise<Set<string>> {
  const surahFiles = ["surah_1.json", "surah_112.json", "surah_113.json", "surah_114.json"];
  const [surahListText, morphologyText, ...surahText] = await Promise.all([
    readFixture("surah_list.json"),
    readFixture("morphology.txt"),
    ...surahFiles.map((file) => readFixture(file)),
  ]);
  const ayahCount = surahText.reduce(
    (total, text) => total + (JSON.parse(text) as unknown[]).length,
    0,
  );
  const quran = await quranSourceParser(
    ayahCount,
    surahFiles.length,
  )({
    archiveKey: "quran/test-fixture",
    raw: bundleQuranSources({ surahListText, surahFiles: surahText, morphologyText }),
  });
  const [arabicText, indonesianText] = await Promise.all([
    readFixture("hadith/ara-abudawud-slice.json"),
    readFixture("hadith/ind-abudawud-slice.json"),
  ]);
  const hadith = await hadithSourceParser()({
    archiveKey: "hadith/test-fixture",
    raw: bundleHadithSources([{ collection: "abudawud", arabicText, indonesianText }]),
  });
  const keys = new Set<string>();
  for (const parent of [...quran, ...hadith]) {
    for (const key of Object.keys(parent.metadata)) keys.add(key);
    for (const child of parent.children) {
      for (const key of Object.keys(child.metadata)) keys.add(key);
    }
  }
  return keys;
}

describe("the filter map is pinned to the metadata ingestion writes", () => {
  it("binds only keys the production ingesters actually write", async () => {
    const written = await ingestedMetadataKeys();
    for (const [dimension, key] of Object.entries(FILTER_DIMENSIONS)) {
      expect(
        written.has(key),
        `${dimension} binds metadata key "${key}", which ingestion never writes`,
      ).toBe(true);
    }
  });

  it("leaves a retired dimension out until ingestion writes its key", async () => {
    const written = await ingestedMetadataKeys();
    for (const key of RETIRED_FILTER_KEYS) {
      expect(
        written.has(key),
        `ingestion now writes "${key}"; restore it to FILTER_DIMENSIONS or retire this guard`,
      ).toBe(false);
    }
  });
});

describe("a dimension that constrains nothing is not a filter", () => {
  it("omits absent, blank and empty dimensions", () => {
    // The router's own convention for "unconstrained" is `""` or `[]`, and the
    // prompt tells the model to use them. Treating them as values would narrow
    // retrieval to a set no row can be in — an empty context, silently.
    expect(metadataFilters({})).toEqual({});
    expect(metadataFilters(undefined)).toEqual({});
    // Blank values are outside the declared vocabulary, which is exactly why
    // they arrive from a model: the runtime defends even where the type does not.
    expect(metadataFilters({ grade: [] })).toEqual({});
    expect(metadataFilters({ grade: ["", "   "] } as never)).toEqual({});
    expect(metadataFilters({ grade: [""], sourceType: ["quran"] } as never)).toEqual({
      sourceType: ["quran"],
    });
    expect(metadataFilters({ grade: "  " } as never)).toEqual({});
  });

  it("trims and deduplicates a dimension's values without reordering them", () => {
    expect(metadataFilters({ grade: [" sahih ", "hasan", "sahih"] } as never)).toEqual({
      grade: ["sahih", "hasan"],
    });
  });
});

describe("a dimension the store cannot express fails loudly", () => {
  it("rejects the spec's snake_case spelling instead of ignoring the key", () => {
    // The near-miss trap: `source_type` is how SPECS.md §3.3 item 3 writes the
    // dimension, and `sourceType` is what the corpus stores. Accepting the
    // former silently would search every source while the trace says one.
    expect(() => metadataFilters({ source_type: ["quran"] } as never)).toThrow(
      FilterNotExpressibleError,
    );
    expect(() => metadataFilters({ source_type: ["quran"] } as never)).toThrow(/unknown_dimension/);
  });

  it.each(RETIRED_FILTER_KEYS)(
    "rejects a filter on the retired %s dimension instead of ignoring it",
    (dimension) => {
      // A stale caller filter on a dimension the corpus no longer (or never)
      // carries must fail the run: ignoring it would reproduce the silent drop
      // the map exists to prevent — retrieval would widen while the trace says
      // the constraint ran.
      const filters = { [dimension]: ["x"] } as never;
      expect(() => metadataFilters(filters)).toThrow(FilterNotExpressibleError);
      try {
        metadataFilters(filters);
        expect.unreachable("a retired dimension must not be ignored");
      } catch (err) {
        expect((err as FilterNotExpressibleError).dimension).toBe(dimension);
        expect((err as FilterNotExpressibleError).reason).toBe("unknown_dimension");
      }
    },
  );

  it("rejects a value the store's ANY(...) binding cannot carry", () => {
    expect(() => metadataFilters({ sourceType: 42 } as never)).toThrow(/not_a_string_list/);
    expect(() => metadataFilters({ sourceType: { any: ["quran"] } } as never)).toThrow(
      /not_a_string_list/,
    );
    expect(() => metadataFilters({ grade: ["sahih", 7] } as never)).toThrow(/not_a_string_list/);
    expect(() => metadataFilters({ grade: null } as never)).not.toThrow();
  });

  it("reports which dimension failed, so the operator can read it off the error", () => {
    try {
      metadataFilters({ source_type: ["quran"] } as never);
      expect.unreachable("an unknown dimension must not be ignored");
    } catch (err) {
      expect(err).toBeInstanceOf(FilterNotExpressibleError);
      expect((err as FilterNotExpressibleError).dimension).toBe("source_type");
      expect((err as FilterNotExpressibleError).reason).toBe("unknown_dimension");
    }
  });
});

describe("the relaxation order is declared, not incidental", () => {
  it("gives up the model's hint before the routing decision itself", () => {
    // The model's grade hint goes first because it is the one most often wrong;
    // the source selection is the routing decision and goes last — dropping it
    // puts every source back in play, the widest possible widening.
    expect(RELAXATION_ORDER).toEqual(["grade", "sourceType"]);
    expect(new Set(RELAXATION_ORDER)).toEqual(new Set(Object.keys(FILTER_DIMENSIONS)));
  });

  it("returns the next live dimension in that order", () => {
    const all = filterEntries({
      sourceType: ["quran"],
      grade: ["sahih"],
    });
    expect(nextRelaxation(all)?.dimension).toBe("grade");
    expect(nextRelaxation(all.filter((e) => e.dimension !== "grade"))?.dimension).toBe(
      "sourceType",
    );
    expect(nextRelaxation([sourceTypeEntry("quran")])?.dimension).toBe("sourceType");
    expect(nextRelaxation([])).toBeUndefined();
  });
});

describe("the source vocabulary the routing decision selects from", () => {
  it("is one list, and the filter type binds to it", () => {
    const values: readonly RoutableSource[] = ROUTABLE_SOURCES;
    expect(values).toContain("quran");
    expect(values).toContain("hadith");
    expect(values).toContain("kitab");
    expect(values).toContain("principle");
    expect(new Set(values).size).toBe(values.length);
  });
});

/**
 * The store record a search is handed: the trace's decision, value for value,
 * with the one read-time expansion the domain owns attached as data.
 *
 * The trap: expanding one filter while silently rewriting the decision. The
 * trace publishes what the route decided, so the values here must be the same
 * values — an expansion that replaced them would make the trace and the search
 * disagree about the question being answered.
 */
describe("storeFilters — the decision's values, plus the derived case where one exists", () => {
  it("attaches the sahihayn expansion to a grade set carrying sahih", () => {
    expect(storeFilters({ grade: ["sahih"] })).toEqual({
      grade: {
        values: ["sahih"],
        whenAbsent: { key: "collection", values: ["bukhari", "muslim"] },
      },
    });
  });

  it("leaves every other dimension and value exactly as the route decided it", () => {
    // The other grade and the other dimension keep exact-equality semantics:
    // nothing widens, and the values are the same ones `metadataFilters` maps.
    expect(storeFilters({ sourceType: ["hadith"], grade: ["hasan"] })).toEqual({
      sourceType: ["hadith"],
      grade: ["hasan"],
    });
    expect(storeFilters({ sourceType: ["quran"] })).toEqual({ sourceType: ["quran"] });
    expect(storeFilters({})).toEqual({});
  });

  it("keeps every value of a mixed set, expanding the clause once", () => {
    const record = storeFilters({ grade: ["hasan", "sahih"] });
    expect(record["grade"]).toEqual({
      values: ["hasan", "sahih"],
      whenAbsent: { key: "collection", values: ["bukhari", "muslim"] },
    });
  });

  it("drops a dimension wholesale, expansion included, when relaxation gives it up", () => {
    // Relaxation works on the unexpanded record, so a dropped dimension is gone
    // rather than leaving its alternative behind in the store record.
    const active = storeFilters({ sourceType: ["hadith"] });
    expect(active).toEqual({ sourceType: ["hadith"] });
    expect(Object.keys(storeFilters({}))).toEqual([]);
  });
});
