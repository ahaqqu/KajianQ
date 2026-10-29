import { describe, expect, it } from "vite-plus/test";
import {
  addToLshIndex,
  LSH_BANDS,
  MAX_CANDIDATES_PER_ROW,
  minhashSignature,
  narratorBlockingKey,
  searchLshIndex,
  SIGNATURE_LENGTH,
} from "./sanadset-blocking";

/**
 * Test intent, named before the assertions:
 * - trap: a blocking key that ignores token order too aggressively would merge two
 *   different narrators, so nasab particles are the only tokens dropped and the result
 *   is asserted to differ when a distinguishing token differs;
 * - trap: the LSH index only proposes candidates — it must never claim a match or lose
 *   a bucket to a duplicate insert;
 * - trap: the per-row candidate cap must be observable (`truncated`), because a
 *   silently capped search would under-report recall.
 */

describe("narratorBlockingKey", () => {
  it("ignores nasab particles and token order", () => {
    expect(narratorBlockingKey("ابو بكر بن ابي شيبه")).toBe(
      narratorBlockingKey("شيبه ابي بكر ابو"),
    );
  });

  it("keeps a name that is nothing but particles", () => {
    expect(narratorBlockingKey("بن ابن")).toBe("بن ابن");
  });

  it("differs when a distinguishing token differs", () => {
    expect(narratorBlockingKey("عبد الله بن عمر")).not.toBe(
      narratorBlockingKey("عبد الله بن عمرو"),
    );
  });
});

describe("minhashSignature", () => {
  it("has one hash per permutation and is stable for the same trigrams", () => {
    const left = minhashSignature(["abc", "bcd", "cde"]);
    const right = minhashSignature(["cde", "abc", "bcd"]);
    expect(left).toHaveLength(SIGNATURE_LENGTH);
    expect(left).toEqual(right);
  });

  it("differs for unrelated trigram sets", () => {
    expect(minhashSignature(["abc", "bcd"])).not.toEqual(minhashSignature(["xyz", "yzw"]));
  });
});

describe("the LSH index", () => {
  it("produces one band key per band", () => {
    expect(minhashSignature(["abc"]).length / 4).toBe(LSH_BANDS);
  });

  it("returns every value inserted under a shared bucket exactly once", () => {
    const index = new Map<string, string[]>();
    addToLshIndex(index, ["k1", "k2"], "first");
    addToLshIndex(index, ["k1"], "second");
    const found = searchLshIndex(index, ["k1", "k2"]);
    expect(found.values.sort()).toEqual(["first", "second"]);
    expect(found.truncated).toBe(false);
  });

  it("reports truncation rather than silently dropping candidates", () => {
    const index = new Map<string, number[]>();
    for (let value = 0; value < MAX_CANDIDATES_PER_ROW + 5; value += 1)
      addToLshIndex(index, ["bucket"], value);
    const found = searchLshIndex(index, ["bucket"]);
    expect(found.values).toHaveLength(MAX_CANDIDATES_PER_ROW);
    expect(found.truncated).toBe(true);
  });

  it("returns nothing for an unknown key", () => {
    expect(searchLshIndex(new Map<string, string[]>(), ["missing"]).values).toEqual([]);
  });
});
