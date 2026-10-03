import { describe, expect, it } from "vitest";
import type { Chunk } from "@app/rag-core";
import { rrfFuse, type TrackHit } from "./chat-fusion";

/**
 * The fusion arithmetic's **total order** (#274, review A3 of the fix round).
 *
 * The retriever's contract is that the caller's array order is the priority
 * order — ADR-0049's neighbour cap truncates on it, so "which neighbour chunks
 * enter the context" is only reproducible if the fused sequence is. Score ties
 * are real (duplicate or near-identical verses are common in this corpus, and
 * two chunks can occupy mirrored ranks), and before the fix the sequence fell
 * back to `Map` insertion order, i.e. to the hit lists' order, which the ANN
 * search does not guarantee for equal distances.
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
