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
  retryInMs,
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

  // Thermo B2: duplicate scores decide ranks via the id tie-break, so the
  // metric is deterministic on every re-run even when vectors repeat (e.g.
  // identical corpus texts) and the input order is adversarial.
  it("is deterministic under duplicate scores regardless of input order", () => {
    const vectors = [
      { id: "d3", vector: [1, 0] },
      { id: "d1", vector: [1, 0] },
      { id: "d2", vector: [1, 0] },
    ];
    const first = rankDocs([1, 0], vectors);
    expect(first.map((r) => r.id)).toEqual(["d1", "d2", "d3"]);
    expect(first.map((r) => r.score)).toEqual([1, 1, 1]);
    // Reversed input must produce the identical ranking.
    const second = rankDocs([1, 0], [...vectors].reverse());
    expect(second.map((r) => r.id)).toEqual(["d1", "d2", "d3"]);
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

  // Thermo B3: brace-balanced extraction — a code-fenced reply must not
  // make the parser grab the fence braces, and a nested object inside the
  // terms object must not swallow the span.
  it("handles markdown-fenced replies without grabbing the fence", () => {
    expect(parseExpansionSelection('```json\n{"terms": ["term"]}\n```')).toEqual(["term"]);
    expect(
      parseExpansionSelection('Sure:\n```\n{"terms": ["t1", "t2"]}\n```\n hope it helps!'),
    ).toEqual(["t1", "t2"]);
  });

  it("scans to the balanced span when prose contains stray braces", () => {
    expect(parseExpansionSelection('} stray { {"terms": ["ok"]} }')).toEqual(["ok"]);
    expect(parseExpansionSelection('{"terms": ["nested {brace} ok"]}')).toEqual([
      "nested {brace} ok",
    ]);
  });

  it("keeps quotes inside strings from breaking the balanced scan", () => {
    expect(parseExpansionSelection('{"terms": ["say \\"hi\\" now"]}')).toEqual(['say "hi" now']);
  });
});

describe("scoreExpansionCase", () => {
  it("passes on exact term match and fails on distractor-only picks", () => {
    expect(scoreExpansionCase({ picked: ["الوُضُوء"] }, "الوُضُوء", ["الغُسْل"])).toBe(true);
    expect(scoreExpansionCase({ picked: ["الغُسْل"] }, "الوُضُوء", ["الغُسْل"])).toBe(false);
    expect(scoreExpansionCase({ picked: [], parseError: "unparseable" }, "الوُضُوء", ["الغُسْل"])).toBe(
      false,
    );
  });

  // Thermo C2: a selection that sweeps the distractors alongside the
  // expected term is not a disambiguation — it fails the case.
  it("fails when a distractor is picked alongside the expected term", () => {
    expect(scoreExpansionCase({ picked: ["الوُضُوء", "الغُسْل"] }, "الوُضُوء", ["الغُسْل"])).toBe(false);
  });

  it("normalizes trim/case for the distractor comparison and ignores a self-equal distractor", () => {
    expect(scoreExpansionCase({ picked: ["الوُضُوء", " الْغُسْل "] }, "الوُضُوء", ["الْغُسْل"])).toBe(false);
    // A distractor accidentally equal to the expected term must not void the case.
    expect(scoreExpansionCase({ picked: ["term"] }, "term", ["term"])).toBe(true);
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

describe("retryInMs", () => {
  it("parses the vendor's 'retry in Ns' hint with a 1s safety margin", () => {
    expect(retryInMs("... Please retry in 47.791139144s.")).toBe(47_792 + 1_000);
  });

  it("parses millisecond hints", () => {
    expect(retryInMs("retry in 250ms")).toBe(250);
  });

  it("returns null when no hint is present", () => {
    expect(retryInMs("quota exhausted")).toBeNull();
    expect(retryInMs("")).toBeNull();
  });
});
