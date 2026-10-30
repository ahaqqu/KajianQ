import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { StoreError } from "@app/infra";
import { NarratorShapeError } from "../narrator";
import { createMemoryRagStore } from "./memory-rag-store";

/**
 * The in-memory double's narrator/chain semantics, without a server.
 *
 * Every DB-less test sees this double, so the properties that make the real read
 * trustworthy are pinned here too: `id` order, the caller's order in a by-id
 * lookup, an unknown id reported rather than dropped, exact (un-normalised) name
 * matching, and a chain sequence that is never sorted or deduplicated. The gated
 * parity suite holds the same answers to the adapter's SQL; this one keeps a
 * regression visible in the default (no-database) gate.
 */

const narrator = (id: string, canonicalNameAr: string, nameVariants: string[] = []) => ({
  id,
  canonicalNameAr,
  nameVariants,
  kunya: null,
  laqab: null,
  deathYear: null,
  tabaqa: null,
  reliabilityByCritic: {},
  metadata: {},
});

function storeWithFixture() {
  const store = createMemoryRagStore();
  // Deliberately seeded out of id order and with two narrators sharing a name.
  store.seedNarrator(narrator("n-b", "same-name"));
  store.seedNarrator(narrator("n-a", "same-name"));
  store.seedNarrator(narrator("n-c", "other", ["same-name"]));
  store.seedChain({
    id: "c-2",
    childId: "child-1",
    collection: "collection-a",
    narratorIds: ["n-b", "n-a", "n-b"],
    grade: "rank-a",
    grader: "grader-a",
    sourceRef: "source:1",
    seq: 2,
  });
  store.seedChain({
    id: "c-1",
    childId: "child-1",
    collection: "collection-b",
    narratorIds: ["n-a"],
    grade: null,
    grader: null,
    sourceRef: null,
    seq: 1,
  });
  store.seedChain({
    id: "c-3",
    childId: "child-2",
    collection: "collection-a",
    narratorIds: ["n-c"],
    grade: null,
    grader: null,
    sourceRef: null,
    seq: 3,
  });
  return store;
}

describe("the memory double's narrator reads", () => {
  it("matches canonical names and variants exactly, returning every row in id order", async () => {
    const store = storeWithFixture();
    const rows = await Effect.runPromise(store.findNarratorsByName("same-name", { limit: 10 }));
    expect(rows.map((row) => row.id)).toEqual(["n-a", "n-b", "n-c"]);
    expect(
      (await Effect.runPromise(store.findNarratorsByName("same-name", { limit: 1 }))).map(
        (row) => row.id,
      ),
    ).toEqual(["n-a"]);
    // No folding: a different spelling is a different string.
    expect(await Effect.runPromise(store.findNarratorsByName("same name", { limit: 10 }))).toEqual(
      [],
    );
    expect(await Effect.runPromise(store.findNarratorsByName("same-name", { limit: 0 }))).toEqual(
      [],
    );
    expect(await Effect.runPromise(store.findNarratorsByName("", { limit: 10 }))).toEqual([]);
  });

  it("resolves ids in the caller's order and names the ids it does not hold", async () => {
    const store = storeWithFixture();
    const lookup = await Effect.runPromise(
      store.getNarratorsByIds(["n-c", "n-a", "n-c", "n-missing"]),
    );
    expect(lookup.narrators.map((row) => row.id)).toEqual(["n-c", "n-a"]);
    expect(lookup.missingIds).toEqual(["n-missing"]);
    expect(await Effect.runPromise(store.getNarratorsByIds([]))).toEqual({
      narrators: [],
      missingIds: [],
    });
  });

  it("canonicalises id spelling before lookup and dedupe", async () => {
    const store = storeWithFixture();
    const lookup = await Effect.runPromise(
      store.getNarratorsByIds(["N-C", "{n-a}", "n-c", "N-MISSING"]),
    );
    // Case, braces and duplicates are one id; the caller's first spelling of a
    // missing id is what the report carries.
    expect(lookup.narrators.map((row) => row.id)).toEqual(["n-c", "n-a"]);
    expect(lookup.missingIds).toEqual(["N-MISSING"]);
  });

  it("does not repair a malformed brace spelling into a seeded id", async () => {
    // Each shape is one brace operation away from a seeded narrator. The adapter
    // rejects all four at the type cast; the double has no type system, so here
    // they must at least stay unresolved instead of being repaired into `n-a` or
    // blanked into the ignored-empty case.
    const store = storeWithFixture();
    for (const malformed of ["{n-a", "n-a}", "{{n-a}}", "{}"]) {
      const lookup = await Effect.runPromise(store.getNarratorsByIds([malformed]));
      expect(lookup.narrators).toEqual([]);
      expect(lookup.missingIds).toEqual([malformed]);
    }
  });
});

describe("the memory double's chain reads", () => {
  it("refuses to seed a grade/grader pairing the database would reject", () => {
    const store = createMemoryRagStore();
    const chain = {
      id: "c-1",
      childId: "child-1",
      collection: "collection-a",
      narratorIds: ["n-a"],
      grade: "sahih" as string | null,
      grader: "grader-a" as string | null,
      sourceRef: null,
      seq: 1,
    };
    for (const [grade, grader] of [
      ["sahih", null],
      [null, "grader-a"],
      ["sahih", "   "],
    ] as const) {
      expect(() => store.seedChain({ ...chain, grade, grader })).toThrow(NarratorShapeError);
    }
    expect(() => store.seedChain({ ...chain, grade: null, grader: null })).not.toThrow();
    expect(() => store.seedChain({ ...chain, grade: "sahih", grader: "al-bukhari" })).not.toThrow();
  });

  it("orders by the seeded insertion sequence even when ids run the other way", async () => {
    const store = createMemoryRagStore();
    for (const [id, seq] of [
      ["c-z", 1],
      ["c-m", 2],
      ["c-a", 3],
    ] as const) {
      store.seedChain({
        id,
        childId: "child-1",
        collection: "collection-a",
        narratorIds: ["n-a"],
        grade: null,
        grader: null,
        sourceRef: null,
        seq,
      });
    }
    const chains = await Effect.runPromise(store.listChainsForChild("child-1", { limit: 10 }));
    expect(chains.map((chain) => chain.id)).toEqual(["c-z", "c-m", "c-a"]);
  });

  it("orders a child's chains by insertion and keeps the sequence verbatim", async () => {
    const store = storeWithFixture();
    const chains = await Effect.runPromise(store.listChainsForChild("child-1", { limit: 10 }));
    expect(chains.map((chain) => chain.id)).toEqual(["c-1", "c-2"]);
    expect(chains[1]?.narratorIds).toEqual(["n-b", "n-a", "n-b"]);
    expect(chains[2] ?? null).toBeNull();
    expect(await Effect.runPromise(store.listChainsForChild("child-1", { limit: 1 }))).toHaveLength(
      1,
    );
    expect(await Effect.runPromise(store.listChainsForChild("child-1", { limit: 0 }))).toEqual([]);
    expect(
      await Effect.runPromise(store.listChainsForChild("child-missing", { limit: 5 })),
    ).toEqual([]);
  });

  it("pages a collection by the id cursor, exclusive of the cursor itself", async () => {
    const store = storeWithFixture();
    const first = await Effect.runPromise(
      store.listChainsByCollection("collection-a", { limit: 1 }),
    );
    expect(first.rows.map((chain) => chain.id)).toEqual(["c-2"]);
    expect(first.nextAfterId).toBe("c-2");
    const second = await Effect.runPromise(
      store.listChainsByCollection("collection-a", { limit: 2, afterId: first.nextAfterId! }),
    );
    expect(second.rows.map((chain) => chain.id)).toEqual(["c-3"]);
    expect(second.nextAfterId).toBeNull();
    expect(
      await Effect.runPromise(store.listChainsByCollection("collection-a", { limit: 0 })),
    ).toEqual({ rows: [], nextAfterId: null });
  });
});

describe("the memory double's chain writes", () => {
  async function storeWithWritableChild() {
    const store = createMemoryRagStore();
    const parentId = await Effect.runPromise(
      store.insertDocParent({ sourceKey: "p", title: "p", metadata: {} }),
    );
    const ids = await Effect.runPromise(
      store.insertDocChildren([
        {
          parentId,
          textRaw: "t",
          textAr: "t",
          textId: null,
          citation: {},
          embeddingPrimary: null,
          embeddingFallback: null,
          ordinal: 0,
          metadata: {},
        },
      ]),
    );
    const narratorId = await Effect.runPromise(
      store.upsertNarrator({ identityKey: "identity:one", canonicalNameAr: "نافع" }),
    );
    return { store, childId: ids[0] as string, narratorId: narratorId.id };
  }

  it("refuses a chain whose child does not exist, as the foreign key does", async () => {
    const { store, narratorId } = await storeWithWritableChild();
    const error = await Effect.runPromise(
      Effect.flip(
        store.insertNarratorChains([
          {
            childId: "missing-child",
            collection: "c",
            narratorIds: [narratorId],
            grade: null,
            grader: null,
            sourceRef: "s:1",
          },
        ]),
      ),
    );
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).kind).toBe("constraint");
    expect(store.allChains()).toHaveLength(0);
  });

  it("refuses a grade outside CONTEXT.md's four, as the CHECK does", async () => {
    const { store, childId, narratorId } = await storeWithWritableChild();
    const error = await Effect.runPromise(
      Effect.flip(
        store.insertNarratorChains([
          {
            childId,
            collection: "c",
            narratorIds: [narratorId],
            grade: "rank-a",
            grader: "grader-a",
            sourceRef: "s:1",
          },
        ]),
      ),
    );
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).kind).toBe("constraint");
    expect(store.allChains()).toHaveLength(0);
  });

  it("refuses a batch that repeats a source address, as one statement would", async () => {
    const { store, childId, narratorId } = await storeWithWritableChild();
    const row = {
      childId,
      collection: "c",
      narratorIds: [narratorId],
      grade: null,
      grader: null,
      sourceRef: "s:1",
    };
    const error = await Effect.runPromise(
      Effect.flip(store.insertNarratorChains([row, { ...row }])),
    );
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).kind).toBe("constraint");
    expect(store.allChains()).toHaveLength(0);

    await Effect.runPromise(store.insertNarratorChains([row]));
    expect(store.allChains()).toHaveLength(1);
  });
});
