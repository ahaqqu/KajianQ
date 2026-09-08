import { describe, expect, it } from "vitest";
import { GoldenSetLoadError, assertV0Shape, loadGoldenSetJson, parseGoldenSet } from "./golden-set";

const validSet = {
  id: "golden-set-test",
  status: "v0-draft",
  questions: [
    {
      id: "q1",
      question: "test question",
      language: "id",
      expectedSourceTypes: ["quran"],
      requiredCitations: ["QS. 1:1"],
      expectedBehavior: "answer",
    },
  ],
};

describe("parseGoldenSet", () => {
  it("accepts a well-formed set", () => {
    const set = parseGoldenSet(validSet);
    expect(set.questions).toHaveLength(1);
    expect(set.questions[0]?.id).toBe("q1");
  });

  it("rejects a question with an empty question text", () => {
    expect(() =>
      parseGoldenSet(
        { ...validSet, questions: [{ ...validSet.questions[0], question: "" }] },
        "bad.json",
      ),
    ).toThrow(GoldenSetLoadError);
  });

  it("rejects an unknown expectedBehavior", () => {
    expect(() =>
      parseGoldenSet(
        {
          ...validSet,
          questions: [{ ...validSet.questions[0], expectedBehavior: "shrug" }],
        },
      ),
    ).toThrow(GoldenSetLoadError);
  });

  it("rejects a non-array questions field", () => {
    expect(() => parseGoldenSet({ ...validSet, questions: "nope" })).toThrow(
      GoldenSetLoadError,
    );
  });
});

describe("loadGoldenSetJson", () => {
  it("parses valid JSON", () => {
    const set = loadGoldenSetJson(JSON.stringify(validSet), "x.json");
    expect(set.id).toBe("golden-set-test");
  });

  it("reports invalid JSON as a load error naming the source", () => {
    expect(() => loadGoldenSetJson("{not json", "x.json")).toThrow(/x\.json/);
  });
});

describe("assertV0Shape", () => {
  const q = (over: Record<string, unknown>) => ({
    ...validSet.questions[0],
    id: `q-${Math.random().toFixed(6)}`,
    ...over,
  });

  it("accepts a fixture meeting the v0 bar", () => {
    const set = parseGoldenSet({
      id: "v0",
      status: "v0-draft",
      questions: [
        q({ language: "id", tags: [] }),
        q({ language: "id", tags: [] }),
        q({ language: "id", tags: [] }),
        q({ language: "en", tags: [] }),
        q({ language: "id", expectedBehavior: "refuse", tags: [] }),
        q({ language: "id", tags: ["dhaif-trap"] }),
      ],
    });
    // Lower the bar for the unit test via the parameterized knobs.
    expect(() =>
      assertV0Shape(set, {
        trapTag: "dhaif-trap",
        minIndonesian: 3,
        minRefusals: 1,
        minTraps: 1,
        minQuestions: 6,
      }),
    ).not.toThrow();
  });

  it("rejects a fixture below the Indonesian minimum", () => {
    const set = parseGoldenSet({
      id: "v0",
      status: "v0-draft",
      questions: [q({ language: "en", tags: [] })],
    });
    expect(() => assertV0Shape(set, { trapTag: "dhaif-trap", minQuestions: 1 })).toThrow(
      /Indonesian/,
    );
  });

  it("rejects a fixture without the trap tag", () => {
    const set = parseGoldenSet({
      id: "v0",
      status: "v0-draft",
      questions: [q({ language: "id", tags: [] })],
    });
    expect(() =>
      assertV0Shape(set, { trapTag: "dhaif-trap", minIndonesian: 0, minRefusals: 0, minTraps: 1, minQuestions: 1 }),
    ).toThrow(/trap/);
  });

  it("rejects a fixture without refusal cases", () => {
    const set = parseGoldenSet({
      id: "v0",
      status: "v0-draft",
      questions: [q({ language: "id", tags: [] })],
    });
    expect(() =>
      assertV0Shape(set, { trapTag: "dhaif-trap", minIndonesian: 0, minRefusals: 1, minTraps: 0, minQuestions: 1 }),
    ).toThrow(/refusal/);
  });
});