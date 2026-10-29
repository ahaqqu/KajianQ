import { describe, expect, it } from "vite-plus/test";
import { lshBandKeys, minhashSignature } from "./sanadset-blocking";
import { buildMatnPairCandidates, type StudyPair } from "./sanadset-pairs";
import { matnTrigrams } from "./sanadset-text";
import type { PreparedRow } from "./sanadset-prepare";

/**
 * Test intent, named before the assertions:
 * - trap: an `exact` pair must be exact *after the fold* while the two raw strings still
 *   differ. A byte-identical pair is a free answer — it would inflate the macro-F1 the
 *   sample exists to measure and spend a call on a question with no signal;
 * - trap: the same string must not leak into another stratum. The near-duplicate band
 *   scores an identical pair at 1.0, so the exclusion is asserted across every stratum of
 *   the pool, not only the exact one.
 */

const BUKHARI = "صحيح البخاري";
const MUSLIM = "صحيح مسلم";

function row(
  rowIndex: number,
  rawMatn: string,
  normalizedMatn: string = rawMatn,
  book: PreparedRow["book"] = BUKHARI,
): PreparedRow {
  const trigrams = matnTrigrams(normalizedMatn);
  const signature = minhashSignature(trigrams);
  return {
    rowIndex,
    book,
    hadithNumber: String(rowIndex),
    rawMatn,
    normalizedMatn,
    trigrams,
    signature,
    bandKeys: lshBandKeys(signature),
    chain: [],
    rawChain: [],
  };
}

function pairsOf(pool: ReturnType<typeof buildMatnPairCandidates>): StudyPair[] {
  return [...pool.values()].flat();
}

describe("the matn candidate pool", () => {
  it("pairs a folded duplicate against the first distinct raw spelling", () => {
    const pool = buildMatnPairCandidates([
      row(0, "raw one", "folded text"),
      row(1, "raw two", "folded text"),
      row(2, "raw three", "folded text"),
    ]);
    const exact = pool.get("matn_exact") ?? [];
    expect(exact).toHaveLength(2);
    expect(exact.every((pair) => pair.a !== pair.b)).toBe(true);
    expect(exact.every((pair) => pair.stratum === "matn_exact")).toBe(true);
    expect(exact.map((pair) => pair.ref.rowA)).toEqual([0, 0]);
  });

  it("never proposes a pair whose two sides are the same string", () => {
    const pool = buildMatnPairCandidates([
      row(0, "identical text"),
      row(1, "identical text"),
      row(2, "identical text"),
    ]);
    for (const pair of pairsOf(pool)) expect(pair.a).not.toBe(pair.b);
    expect(pool.get("matn_exact")).toBeUndefined();
  });

  it("keeps a near-duplicate whose raw strings differ", () => {
    // 9 of 10 shared trigrams: 0.90, inside the near-duplicate band and below raw equality.
    const pool = buildMatnPairCandidates([
      row(0, "aaa bbb ccc", "aaa bbb ccc"),
      row(1, "aaa bbb ccd", "aaa bbb ccd"),
    ]);
    const near = pool.get("matn_near_duplicate") ?? [];
    expect(near).toHaveLength(1);
    expect(near[0]?.a).not.toBe(near[0]?.b);
  });

  it("does not pair a matn across books, so a cross-book join is never a candidate", () => {
    const pool = buildMatnPairCandidates([
      row(0, "shared text", "shared text", BUKHARI),
      row(1, "shared text", "shared text", MUSLIM),
    ]);
    expect(pairsOf(pool)).toEqual([]);
  });
});
