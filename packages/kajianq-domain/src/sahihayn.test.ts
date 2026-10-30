import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { storeFilters } from "./chat-filter-policy";
import { storeKeyOf } from "./filters";
import { HADITH_COLLECTIONS, hadithMetadata, type HadithRecord } from "./hadith-source";
import { SAHIHAYN_BASIS, effectiveGrade, sahihFilterExpansion } from "./sahihayn";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";

/**
 * **The sahihayn derivation** — the one fact both retrieval consumers read.
 *
 * The corpus stores no grade for Bukhari or Muslim rows, and ADR-0026 forbids
 * writing one. The ruling behind the derivation: the collection itself is the
 * evidence, so a row from either is *read* as sahih at read time — for the
 * hierarchy bonus and the `grade` filter only, never in stored metadata and never
 * in a citation label.
 *
 * The trap this suite names before it tests it: applying the derivation one way
 * while the other consumer still keys on the stored grade. Either half alone
 * looks correct and leaves the corpus's most authoritative rows out of a filter
 * or below a lesser-ranked narration, and no gate would notice. The last case
 * here composes the two — a row is matched by the filter exactly when the
 * derivation calls it sahih — so the halves cannot drift apart silently.
 */

/** A hadith record as the parser hands it to `hadithMetadata`: no stored grades. */
const ungraded = (collection: HadithRecord["collection"]): HadithRecord => ({
  collection,
  hadithNo: "1",
  bookNo: 1,
  bookName: null,
  textAr: "arabic",
  textId: "indonesian",
  grades: [],
});

describe("effectiveGrade — the collection is the evidence where the source grades nothing", () => {
  it("reads an ungraded row from either sahihayn collection as sahih", () => {
    for (const collection of SAHIHAYN_BASIS.collections) {
      // The corpus's own shape is the JSON `null` the ingestion writes…
      expect(effectiveGrade({ collection, grade: null })).toBe("sahih");
      // …and a row whose key is missing entirely is the same absence to the store.
      expect(effectiveGrade({ collection })).toBe("sahih");
      expect(effectiveGrade({ collection, grades: [] })).toBe("sahih");
    }
  });

  it("leaves an ungraded row from every other collection ungraded", () => {
    // Iterates the registry, so a collection added later cannot quietly become
    // sahih: only the basis names the two it applies to.
    const others = HADITH_COLLECTIONS.filter(
      (collection) => !(SAHIHAYN_BASIS.collections as readonly string[]).includes(collection),
    );
    expect(others.length).toBeGreaterThan(0);
    for (const collection of others) {
      expect(effectiveGrade({ collection, grade: null })).toBeUndefined();
      expect(effectiveGrade({ collection })).toBeUndefined();
    }
  });

  it("never overrides a grade the source gave, the sahihayn included", () => {
    // A sahihayn row the source graded weak is weak — the derivation fills an
    // absence, it does not outrank the source.
    expect(effectiveGrade({ collection: "bukhari", grade: "dhaif" })).toBe("dhaif");
    expect(effectiveGrade({ collection: "muslim", grade: "hasan" })).toBe("hasan");
    expect(effectiveGrade({ collection: "nasai", grade: "sahih" })).toBe("sahih");
    expect(effectiveGrade({ grade: "mutawatir" })).toBe("mutawatir");
  });

  it("does not reinterpret a present value that is not a grade it knows", () => {
    // A stored value the pack cannot read is not an absence: it is present, so
    // neither the bonus nor the filter may read it as sahih.
    expect(effectiveGrade({ collection: "bukhari", grade: "Sahih" })).toBeUndefined();
    expect(effectiveGrade({ collection: "bukhari", grade: 1 })).toBeUndefined();
  });

  it("reads the keys the ingestion actually writes, and the filter binds", () => {
    // The derivation is only as good as its keys: a grade stored under another
    // name, or a collection the metadata does not carry, would leave both
    // consumers silently blind. This pins them to the ingester's own output and
    // to the dimension the store's absent-key case is attached to.
    const metadata = hadithMetadata(ungraded("bukhari"));
    expect(Object.hasOwn(metadata, SAHIHAYN_BASIS.gradeKey)).toBe(true);
    expect(metadata[SAHIHAYN_BASIS.gradeKey]).toBeNull();
    expect(metadata[SAHIHAYN_BASIS.collectionKey]).toBe("bukhari");
    expect(storeKeyOf("grade")).toBe(SAHIHAYN_BASIS.gradeKey);
    expect(effectiveGrade(metadata)).toBe("sahih");
  });
});

describe("sahihFilterExpansion — the filter's expression of the same fact", () => {
  it("expands a set carrying sahih, keeping the decision's values", () => {
    const expected = {
      values: ["sahih"],
      whenAbsent: { key: "collection", values: ["bukhari", "muslim"] },
    };
    expect(sahihFilterExpansion(["sahih"])).toEqual(expected);
    expect(sahihFilterExpansion(["hasan", "sahih"])).toEqual({
      ...expected,
      values: ["hasan", "sahih"],
    });
  });

  it("expands nothing for any other grade", () => {
    for (const values of [["hasan"], ["dhaif"], ["mutawatir"], ["hasan", "dhaif"], []]) {
      expect(sahihFilterExpansion(values)).toBeUndefined();
    }
  });

  it("is the same basis the resolver reads", () => {
    const expansion = sahihFilterExpansion(["sahih"]);
    expect(expansion?.whenAbsent?.key).toBe(SAHIHAYN_BASIS.collectionKey);
    expect(expansion?.whenAbsent?.values).toEqual([...SAHIHAYN_BASIS.collections]);
  });
});

/**
 * The two consumers composed: the store record the retriever hands a search must
 * match a row exactly when {@link effectiveGrade} reads that row as sahih. The
 * memory store implements the seam's documented filter semantics, so this runs
 * the real filter record through a real `RagStore` rather than restating either
 * side of the law.
 */
describe("the filter and the bonus agree on every grade-and-collection shape", () => {
  const ROWS = [
    { slug: "bukhari-null", metadata: { collection: "bukhari", grade: null } },
    { slug: "muslim-missing", metadata: { collection: "muslim" } },
    { slug: "nasai-null", metadata: { collection: "nasai", grade: null } },
    { slug: "tirmidhi-sahih", metadata: { collection: "tirmidhi", grade: "sahih" } },
    { slug: "bukhari-dhaif", metadata: { collection: "bukhari", grade: "dhaif" } },
    { slug: "malik-hasan", metadata: { collection: "malik", grade: "hasan" } },
  ] as const;

  it("matches the rows it reads as sahih, and only those", async () => {
    const store = createMemoryRagStore();
    const parentId = await Effect.runPromise(
      store.insertDocParent({ sourceKey: "hadith/fixture/1", title: "fixture", metadata: {} }),
    );
    await Effect.runPromise(
      store.insertDocChildren(
        ROWS.map((row, ordinal) => ({
          parentId,
          textRaw: `raw-${row.slug}`,
          textAr: `ar-${row.slug}`,
          textId: null,
          citation: { slug: row.slug },
          embeddingPrimary: [1, 0],
          embeddingFallback: [1, 0],
          ordinal,
          metadata: { sourceType: "hadith", slug: row.slug, ...row.metadata },
        })),
      ),
    );

    const hits = await Effect.runPromise(
      store.similaritySearch("primary", [1, 0], {
        limit: ROWS.length,
        filters: storeFilters({ grade: ["sahih"] }),
      }),
    );
    const matched = hits.map((hit) => hit.child.metadata["slug"] as string).sort();

    expect(matched).toEqual(["bukhari-null", "muslim-missing", "tirmidhi-sahih"]);
    // The law itself, row by row: matched by the filter ⇔ read as sahih.
    for (const row of ROWS) {
      const derived = effectiveGrade({ ...row.metadata }) === "sahih";
      expect(matched.includes(row.slug)).toBe(derived);
    }
  });

  it("matches nothing extra for a grade the derivation does not touch", async () => {
    // The ungraded sahihayn rows are read as sahih, not as hasan: a hasan filter
    // must not pick them up.
    const store = createMemoryRagStore();
    const parentId = await Effect.runPromise(
      store.insertDocParent({ sourceKey: "hadith/fixture/2", title: "fixture", metadata: {} }),
    );
    await Effect.runPromise(
      store.insertDocChildren(
        ROWS.map((row, ordinal) => ({
          parentId,
          textRaw: `raw-${row.slug}`,
          textAr: `ar-${row.slug}`,
          textId: null,
          citation: { slug: row.slug },
          embeddingPrimary: [1, 0],
          embeddingFallback: [1, 0],
          ordinal,
          metadata: { sourceType: "hadith", slug: row.slug, ...row.metadata },
        })),
      ),
    );
    const hits = await Effect.runPromise(
      store.similaritySearch("primary", [1, 0], {
        limit: ROWS.length,
        filters: storeFilters({ grade: ["hasan"] }),
      }),
    );
    expect(hits.map((hit) => hit.child.metadata["slug"])).toEqual(["malik-hasan"]);
  });
});
