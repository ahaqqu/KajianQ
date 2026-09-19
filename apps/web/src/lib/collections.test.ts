import { describe, expect, it } from "vitest";
import {
  COLLECTION_CATEGORIES,
  COLLECTION_ENTRIES,
  byStatus,
  filterByCategory,
  type CollectionEntry,
} from "./collections";
import { messages } from "./i18n";

/**
 * The collection data module is the page's content (the markdown register is
 * never imported at runtime), so its shape and its available/planned split are
 * pinned here: a mislabeled entry would present registered work as an ingested
 * source — the one claim the page must never make.
 */

const FIELDS = ["century", "title", "author", "description"] as const;

describe("collection data", () => {
  it("carries both available and planned entries", () => {
    expect(byStatus(COLLECTION_ENTRIES, "available").length).toBeGreaterThan(0);
    expect(byStatus(COLLECTION_ENTRIES, "planned").length).toBeGreaterThan(0);
  });

  it("gives every entry a unique id", () => {
    const ids = COLLECTION_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("fills every localized field in both locales", () => {
    for (const entry of COLLECTION_ENTRIES) {
      for (const field of FIELDS) {
        expect(entry[field].en.length, `${entry.id}.${field}.en`).toBeGreaterThan(0);
        expect(entry[field].id.length, `${entry.id}.${field}.id`).toBeGreaterThan(0);
      }
    }
  });

  it("files every entry under a known category", () => {
    for (const entry of COLLECTION_ENTRIES) {
      expect(COLLECTION_CATEGORIES, entry.id).toContain(entry.category);
    }
  });

  it("registers a planRef on every planned entry and none on an available one", () => {
    for (const entry of COLLECTION_ENTRIES) {
      if (entry.status === "planned") {
        expect(entry.planRef, entry.id).toBeTruthy();
      } else {
        expect(entry.planRef, entry.id).toBeUndefined();
        // An available source must say where it came from (the attribution
        // register's one-line note).
        expect(entry.attribution, entry.id).toBeDefined();
      }
    }
  });

  it("names the sources the register and the spec list as available today", () => {
    const availableIds = byStatus(COLLECTION_ENTRIES, "available").map((entry) => entry.id);
    expect(availableIds).toEqual([
      "quran-tanzil-uthmani",
      "quran-kemenag-id",
      "quran-arabic-corpus-morphology",
      "hadith-fawazahmed0",
      "hadith-sunnah-com",
    ]);
  });

  it("lists the registered planned work with its references", () => {
    const planned = byStatus(COLLECTION_ENTRIES, "planned");
    const refs = planned.map((entry) => entry.planRef);
    // Priority kitab (tracer + scale-out), the three complete corpora, the
    // tafsir set in SPECS §4.1, #141's staging collection, and the
    // terminology seeds (issue #24 / ADR-0014).
    expect(refs).toContain("#21");
    expect(refs).toContain("#22");
    expect(refs).toContain("#33");
    expect(refs).toContain("#35");
    expect(refs).toContain("#27–#31");
    expect(refs).toContain("#141");
    expect(refs).toContain("ADR-0014 · #24");
    expect(refs).toContain("SPECS §4.1");
  });

  it("keeps no tafsir entry marked available (SPECS §4.1 lists it as planned)", () => {
    const tafsir = COLLECTION_ENTRIES.filter((entry) => entry.category === "tafsir");
    expect(tafsir.length).toBeGreaterThan(0);
    for (const entry of tafsir) expect(entry.status).toBe("planned");
  });

  it("never uses a category without a filter-tab label", () => {
    const labels: Record<CollectionEntry["category"], string> = {
      scripture: "collectionFilterScripture",
      hadith: "collectionFilterHadith",
      tafsir: "collectionFilterTafsir",
      kitab: "collectionFilterKitab",
      theology: "collectionFilterTheology",
      spirituality: "collectionFilterSpirituality",
      terminology: "collectionFilterTerminology",
    };
    for (const category of COLLECTION_CATEGORIES) {
      const key = labels[category] as keyof (typeof messages)["en"];
      expect(messages.en[key].length).toBeGreaterThan(0);
      expect(messages.id[key].length).toBeGreaterThan(0);
    }
  });
});

describe("filterByCategory", () => {
  it("returns every entry (a copy) for `all`", () => {
    const all = filterByCategory(COLLECTION_ENTRIES, "all");
    expect(all).toEqual([...COLLECTION_ENTRIES]);
    expect(all).not.toBe(COLLECTION_ENTRIES);
  });

  it("keeps only the matching category, preserving order", () => {
    const hadith = filterByCategory(COLLECTION_ENTRIES, "hadith");
    expect(hadith.length).toBeGreaterThan(0);
    for (const entry of hadith) expect(entry.category).toBe("hadith");
    const expectedOrder = COLLECTION_ENTRIES.filter((e) => e.category === "hadith");
    expect(hadith).toEqual(expectedOrder);
  });

  it("returns an empty list for a category with no entries", () => {
    const empty: readonly CollectionEntry[] = COLLECTION_ENTRIES.filter(
      (entry) => entry.category === "terminology",
    );
    expect(filterByCategory([], "kitab")).toEqual([]);
    expect(filterByCategory(empty, "terminology").length).toBe(1);
  });
});

describe("byStatus", () => {
  it("splits the entries by availability, preserving order", () => {
    for (const status of ["available", "planned"] as const) {
      const subset = byStatus(COLLECTION_ENTRIES, status);
      expect(subset.length).toBeGreaterThan(0);
      for (const entry of subset) expect(entry.status).toBe(status);
    }
    expect(byStatus(COLLECTION_ENTRIES, "available").length).toBe(
      COLLECTION_ENTRIES.filter((e) => e.status === "available").length,
    );
  });
});
