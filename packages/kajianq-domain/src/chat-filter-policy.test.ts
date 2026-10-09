import { describe, expect, it } from "vitest";
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
  type FilterEntry,
} from "./chat-filter-policy";

/**
 * **The routing invariant, at its narrowest point.**
 *
 * The trace publishes a routing decision — "these sources, these filters" —
 * and retrieval runs a SQL `WHERE metadata->>key = ANY(values)` built from it.
 * The two must be the same object, and every filter dimension must reach the
 * store. The silent failure this suite exists to catch: `metadataFilters`
 * mapped only three dimensions, so `sourceType` and `principleTags` could be
 * *decided* by the router and *dropped* by the mapping with no compile error,
 * no runtime error, and nothing in the trace — the route answered a different
 * question than the router chose, and no gate would notice.
 *
 * Two traps are named here before they are written:
 *
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
      madzhab: ["syafii"],
      grade: ["sahih"],
      textLayer: ["matn"],
      principleTags: ["yusr"],
    };
    expect(Object.keys(samples).sort()).toEqual(declared);
  });

  it.each([
    ["sourceType", "sourceType", { sourceType: ["quran"] }],
    ["madzhab", "madzhab", { madzhab: ["syafii"] }],
    ["grade", "grade", { grade: ["sahih", "hasan"] }],
    ["textLayer", "textLayer", { textLayer: ["matn"] }],
    ["principleTags", "principleTags", { principleTags: ["yusr"] }],
  ] as const)("binds the %s dimension to its store key", (dimension, key, filters) => {
    expect(metadataFilters(filters)).toEqual({ [key]: filters[dimension as keyof typeof filters] });
  });

  it("carries a set-valued dimension through as a set, in declared order", () => {
    // Spec §3.3 item 3's `grade IN (…)` and `principle_tags ANY (…)`: several
    // values must survive to the store, not collapse to the first.
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
    expect(() => metadataFilters({ principle_tags: ["yusr"] } as never)).toThrow(
      /unknown_dimension/,
    );
  });

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
  it("gives up the expected-empty hints before the routing decision itself", () => {
    // The Principle Index is not ingested yet (#16), and no corpus row carries a
    // text-layer key, so those two hints are the ones most often wrong; the
    // source selection is the stage-3 decision and goes last, because dropping
    // it puts every source back in play — the widest possible widening.
    expect(RELAXATION_ORDER).toEqual([
      "principleTags",
      "textLayer",
      "grade",
      "madzhab",
      "sourceType",
    ]);
    expect(new Set(RELAXATION_ORDER)).toEqual(new Set(Object.keys(FILTER_DIMENSIONS)));
  });

  it("returns the next live dimension in that order", () => {
    const all = filterEntries({
      sourceType: ["quran"],
      madzhab: ["syafii"],
      grade: ["sahih"],
      textLayer: ["matn"],
      principleTags: ["yusr"],
    });
    expect(nextRelaxation(all)?.dimension).toBe("principleTags");
    expect(nextRelaxation(all.filter((e) => e.dimension !== "principleTags"))?.dimension).toBe(
      "textLayer",
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
