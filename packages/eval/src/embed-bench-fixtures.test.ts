import { describe, expect, it } from "vitest";
import { parseExpansionSet, parseProbeSet } from "./embed-bench-fixtures";

describe("parseProbeSet", () => {
  it("validates a well-formed probe set", () => {
    const set = parseProbeSet({
      id: "probes-v0",
      corpusFingerprint: "fnv1a64:abc:3",
      crossLingual: [{ id: "q1", text: "apa itu", relevantIds: ["d1"] }],
      monolingual: [{ id: "q2", text: "كتاب", relevantIds: ["d2"] }],
    });
    expect(set.crossLingual).toHaveLength(1);
    expect(set.monolingual[0]!.relevantIds).toEqual(["d2"]);
  });

  it("rejects empty relevantIds and missing fields", () => {
    expect(() =>
      parseProbeSet({ id: "x", corpusFingerprint: "f", crossLingual: [], monolingual: [] }),
    ).toThrow();
    expect(() =>
      parseProbeSet({
        id: "x",
        corpusFingerprint: "f",
        crossLingual: [{ id: "q", text: "t", relevantIds: [] }],
        monolingual: [],
      }),
    ).toThrow();
  });
});

describe("parseExpansionSet", () => {
  it("validates cases with expected terms and distractors", () => {
    const set = parseExpansionSet({
      id: "cases-v0",
      cases: [
        {
          id: "c1",
          query: "bagaimana bersuci",
          slice: { concept: "purity", terms: [] },
          expectedTerm: "الطَّهُور",
          distractors: ["النِّكَاح"],
        },
      ],
    });
    expect(set.cases[0]!.expectedTerm).toBe("الطَّهُور");
  });

  it("rejects cases without distractors or an empty case list", () => {
    expect(() =>
      parseExpansionSet({
        id: "x",
        cases: [{ id: "c", query: "q", slice: {}, expectedTerm: "t", distractors: [] }],
      }),
    ).toThrow();
    expect(() => parseExpansionSet({ id: "x", cases: [] })).toThrow();
  });
});
