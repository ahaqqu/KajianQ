import { describe, expect, it } from "vite-plus/test";
import type { Chunk } from "@app/rag-core";
import { HIERARCHY_BONUS, hierarchyBonus, rrfFuse, type TrackHit } from "./chat-fusion";
import { HADITH_COLLECTIONS } from "./hadith-source";
import { SAHIHAYN_BASIS } from "./sahihayn";

/**
 * The fusion arithmetic's **total order**.
 *
 * The retriever's contract is that the caller's array order is the priority
 * order — ADR-0049's neighbour cap truncates on it, so "which neighbour chunks
 * enter the context" is only reproducible if the fused sequence is. Score ties
 * are real (duplicate or near-identical verses are common in this corpus, and
 * two chunks can occupy mirrored ranks), so the tie-break cannot fall back to
 * the hit lists' order, which the ANN search does not guarantee for equal
 * distances.
 */

const chunk = (id: string): Chunk => ({ id, text: id });

/** One single-hit track per id — every chunk lands at rank 1, so scores tie. */
const equalScoringLists = (ids: readonly string[]): TrackHit[][] =>
  ids.map((id) => [{ chunk: chunk(id), rank: 1 }]);

describe("rrfFuse — the order is total", () => {
  it("breaks equal scores by chunk id, whatever order the hit lists arrived in", () => {
    const orderOf = (ids: readonly string[]): string[] =>
      rrfFuse(equalScoringLists(ids), () => 0).map((c) => c.id);
    expect(orderOf(["b", "a"])).toEqual(["a", "b"]);
    expect(orderOf(["a", "b"])).toEqual(["a", "b"]);
    expect(orderOf(["c", "a", "b"])).toEqual(["a", "b", "c"]);
  });

  it("keeps the score order wherever the scores differ", () => {
    // The tie-break must not reorder real evidence: rank 1 outranks rank 2 even
    // though the id sorts after it.
    const fused = rrfFuse(
      [
        [
          { chunk: chunk("z"), rank: 1 },
          { chunk: chunk("a"), rank: 2 },
        ],
      ],
      () => 0,
    );
    expect(fused.map((c) => c.id)).toEqual(["z", "a"]);
    expect(fused[0]?.score).toBeGreaterThan(fused[1]?.score ?? 0);
  });
});

/**
 * The hierarchy bonuses (spec §3.3 item 4): Quran +0.3, Sahih +0.25, Hasan
 * +0.15, Kitab +0.1. Each is a property of the chunk alone — its source type
 * and grade — so the fused order never depends on the question: the function
 * takes no question input a caller could vary.
 */
describe("hierarchyBonus — the spec's magnitudes, including the two that were missing", () => {
  const bonus = (metadata: Record<string, unknown>): number =>
    hierarchyBonus({ id: "c", text: "t", metadata });

  it("scores each named source and grade exactly once", () => {
    expect(bonus({ sourceType: "quran" })).toBe(HIERARCHY_BONUS.quran);
    expect(bonus({ sourceType: "kitab" })).toBe(HIERARCHY_BONUS.kitab);
    expect(bonus({ grade: "sahih" })).toBe(HIERARCHY_BONUS.sahih);
    expect(bonus({ grade: "hasan" })).toBe(HIERARCHY_BONUS.hasan);
    expect(bonus({ sourceType: "quran", grade: "sahih" })).toBeCloseTo(
      HIERARCHY_BONUS.quran + HIERARCHY_BONUS.sahih,
    );
  });

  it("gives a weak grade nothing — dhaif is flagged, never boosted", () => {
    expect(bonus({ grade: "dhaif" })).toBe(0);
    expect(bonus({ grade: "mutawatir" })).toBe(0);
    expect(bonus({ sourceType: "hadith", grade: "dhaif" })).toBe(0);
  });

  it("gives an ungraded sahihayn row the Sahih bonus — the collection is the evidence", () => {
    for (const collection of SAHIHAYN_BASIS.collections) {
      expect(bonus({ sourceType: "hadith", collection, grade: null })).toBe(HIERARCHY_BONUS.sahih);
      // A missing grade key is the same absence the store's `IS NULL` reads.
      expect(bonus({ sourceType: "hadith", collection })).toBe(HIERARCHY_BONUS.sahih);
    }
  });

  it("gives an ungraded row from every other collection nothing", () => {
    const others = HADITH_COLLECTIONS.filter(
      (collection) => !(SAHIHAYN_BASIS.collections as readonly string[]).includes(collection),
    );
    expect(others.length).toBeGreaterThan(0);
    for (const collection of others) {
      expect(bonus({ sourceType: "hadith", collection, grade: null })).toBe(0);
    }
  });

  it("keeps a sahihayn row's own grade in charge", () => {
    // The derivation fills an absence; a source's weak verdict is never boosted
    // away, and a hasan verdict keeps the hasan magnitude.
    expect(bonus({ sourceType: "hadith", collection: "bukhari", grade: "dhaif" })).toBe(0);
    expect(bonus({ sourceType: "hadith", collection: "muslim", grade: "hasan" })).toBe(
      HIERARCHY_BONUS.hasan,
    );
  });

  it("stops a stored sahih grade outranking an ungraded sahihayn row from a better rank", () => {
    // The authority order the spec states, as a behavioural consequence: both
    // tracks rank the ungraded Bukhari narration first and a stored-sahih Nasai
    // one second. RRF alone makes rank beat one bonus — 1/61 < 1.25/62 — so
    // without the derivation the lesser collection wins; with it the better rank
    // wins (1.25/61 > 1.25/62). Asserting the ORDER, not a number, is what makes
    // this the regression a re-inversion cannot pass.
    const bukhari: Chunk = {
      id: "b",
      text: "bukhari",
      metadata: { sourceType: "hadith", collection: "bukhari", grade: null },
    };
    const nasai: Chunk = {
      id: "n",
      text: "nasai",
      metadata: { sourceType: "hadith", collection: "nasai", grade: "sahih" },
    };
    const lists: TrackHit[][] = [
      [
        { chunk: bukhari, rank: 1 },
        { chunk: nasai, rank: 2 },
      ],
      [
        { chunk: bukhari, rank: 1 },
        { chunk: nasai, rank: 2 },
      ],
    ];
    expect(rrfFuse(lists, (chunk) => hierarchyBonus(chunk)).map((c) => c.id)).toEqual(["b", "n"]);
    expect(hierarchyBonus(bukhari)).toBe(HIERARCHY_BONUS.sahih);
  });

  it("boosts nothing for a source type outside the bonus map", () => {
    expect(bonus({ sourceType: "principle" })).toBe(0);
  });

  it("does not touch a chunk whose metadata carries no source type or grade", () => {
    expect(bonus({})).toBe(0);
    expect(bonus({ sourceType: "concept_link" })).toBe(0);
  });
});
