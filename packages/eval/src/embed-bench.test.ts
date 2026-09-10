import { describe, expect, it } from "vitest";
import {
  BENCH_K,
  GATE_FLOORS,
  cosineSimilarity,
  evaluateGate,
  parseExpansionSelection,
  rankDocs,
  recallAtK,
  reciprocalRank,
  scoreDirection,
  scoreExpansionCase,
  totalCostMicroUsd,
} from "./embed-bench";

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("is symmetric and sign-consistent", () => {
    expect(cosineSimilarity([1, 2], [2, 1])).toBeCloseTo(cosineSimilarity([2, 1], [1, 2]));
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("returns 0 when either vector is all zeros (no divide-by-zero)", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });
});

describe("rankDocs", () => {
  it("orders by descending similarity, tie-breaking by id", () => {
    const ranked = rankDocs(
      [1, 0],
      [
        { id: "b", vector: [1, 0] },
        { id: "a", vector: [1, 0] },
        { id: "c", vector: [0, 1] },
      ],
    );
    expect(ranked.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("recallAtK / reciprocalRank", () => {
  const ranked = [{ id: "x" }, { id: "a" }, { id: "y" }, { id: "b" }];

  it("counts relevant ids inside the top k", () => {
    expect(recallAtK(["a", "b"], ranked, BENCH_K)).toBe(1);
    expect(recallAtK(["a", "y"], ranked, 2)).toBe(0.5);
    expect(recallAtK(["zzz"], ranked)).toBe(0);
  });

  it("is 0 for an empty ground truth (never a vacuous 1)", () => {
    expect(recallAtK([], ranked)).toBe(0);
  });

  it("scores the first relevant hit's reciprocal rank", () => {
    expect(reciprocalRank(["a"], ranked)).toBe(0.5);
    expect(reciprocalRank(["x"], ranked)).toBe(1);
    expect(reciprocalRank(["b"], ranked, 2)).toBe(0);
    expect(reciprocalRank(["zzz"], ranked)).toBe(0);
  });
});

describe("scoreDirection", () => {
  it("aggregates mean recall and MRR over probes", () => {
    const cell = scoreDirection(
      "secondary→primary",
      [
        { query: { id: "q1", text: "", relevantIds: ["a", "b"] }, vector: [1, 0] },
        { query: { id: "q2", text: "", relevantIds: ["a"] }, vector: [0, 1] },
      ],
      [
        { id: "a", vector: [1, 0] },
        { id: "b", vector: [0, 1] },
      ],
    );
    // q1 gets both docs in top-k (recall 1, first relevant at rank 1);
    // q2's relevant doc "a" scores 0 similarity and ranks 2nd of 2 —
    // so mean recall@10 = 1, mean MRR = (1 + 0.5) / 2 = 0.75.
    expect(cell.queries).toBe(2);
    expect(cell.recallAtK).toBeCloseTo(1);
    expect(cell.mrr).toBeCloseTo(0.75);
  });

  it("returns nulls when no probes ran (not a fake 0 or 1)", () => {
    const cell = scoreDirection("primary→primary", [], [{ id: "a", vector: [1] }]);
    expect(cell.queries).toBe(0);
    expect(cell.recallAtK).toBeNull();
    expect(cell.mrr).toBeNull();
  });
});

describe("evaluateGate", () => {
  it("passes only when both floors are met", () => {
    const cells = [
      {
        direction: "secondary→primary" as const,
        queries: 10,
        recallAtK: GATE_FLOORS.crossLingual,
        mrr: 1,
      },
      {
        direction: "primary→primary" as const,
        queries: 10,
        recallAtK: GATE_FLOORS.monolingual,
        mrr: 1,
      },
    ];
    expect(evaluateGate({ cells })).toEqual({
      crossLingualPass: true,
      monolingualPass: true,
      gatePass: true,
    });
  });

  it("fails when either floor is missed", () => {
    const below = (v: number) => v - 0.01;
    const cells = [
      {
        direction: "secondary→primary" as const,
        queries: 10,
        recallAtK: below(GATE_FLOORS.crossLingual),
        mrr: 1,
      },
      {
        direction: "primary→primary" as const,
        queries: 10,
        recallAtK: GATE_FLOORS.monolingual,
        mrr: 1,
      },
    ];
    const verdict = evaluateGate({ cells });
    expect(verdict.crossLingualPass).toBe(false);
    expect(verdict.gatePass).toBe(false);
  });

  it("treats a missing cell as a failure (no floor met by absence)", () => {
    expect(evaluateGate({ cells: [] }).gatePass).toBe(false);
  });
});

describe("parseExpansionSelection", () => {
  it("extracts terms from a JSON reply, tolerating prose around it", () => {
    expect(parseExpansionSelection('Sure! {"terms": ["الوُضُوء"] } done')).toEqual(["الوُضُوء"]);
  });

  it("trims and lowercases picks for robust comparison", () => {
    expect(parseExpansionSelection('{"terms": [" Term "]}')).toEqual(["term"]);
  });

  it("returns empty on non-JSON, non-object, or missing terms", () => {
    expect(parseExpansionSelection("no json here")).toEqual([]);
    expect(parseExpansionSelection('{"terms": "not-array"}')).toEqual([]);
    expect(parseExpansionSelection('{"other": 1}')).toEqual([]);
  });
});

describe("scoreExpansionCase", () => {
  it("passes on exact term match and fails on distractor-only picks", () => {
    expect(scoreExpansionCase({ picked: ["الوُضُوء"] }, "الوُضُوء")).toBe(true);
    expect(scoreExpansionCase({ picked: ["الغُسْل"] }, "الوُضُوء")).toBe(false);
    expect(scoreExpansionCase({ picked: [], parseError: "unparseable" }, "الوُضُوء")).toBe(false);
  });
});

describe("totalCostMicroUsd", () => {
  it("sums cost records and tolerates missing fields", () => {
    expect(
      totalCostMicroUsd([
        { modelId: "a", tokensIn: 0, tokensOut: 0, latencyMs: 0, costMicroUsd: 5 },
        { modelId: "b", tokensIn: 0, tokensOut: 0, latencyMs: 0, costMicroUsd: 7 },
      ]),
    ).toBe(12);
  });
});
