import { describe, expect, it } from "vitest";
import {
  DECISION_GATE_FLOORS,
  accuracyByLanguage,
  evaluateDecisionGate,
  meanAccuracy,
  scoreCitationAnswer,
  scoreRelevanceAnswer,
  scoreRerankAnswer,
  type CaseOutcome,
} from "./decision-bench";
import {
  loadDecisionBenchConfig,
  loadDecisionBenchFixtureJson,
  parseDecisionBenchFixture,
  DECISION_BENCH_DEFAULT_FIXTURE_PATH,
} from "./decision-bench-config";

const outcome = (caseId: string, language: string, passed: boolean): CaseOutcome => ({
  caseId,
  language,
  expected: true,
  got: passed ? true : false,
  passed,
});

describe("decision-bench scoring math", () => {
  it("meanAccuracy is null on empty and a ratio otherwise", () => {
    expect(meanAccuracy([])).toBeNull();
    expect(meanAccuracy([outcome("a", "en", true), outcome("b", "en", false)])).toBe(0.5);
  });

  it("accuracyByLanguage groups per language label", () => {
    const by = accuracyByLanguage([
      outcome("a", "ar", true),
      outcome("b", "ar", false),
      outcome("c", "id", true),
    ]);
    expect(by.ar).toEqual({ cases: 2, accuracy: 0.5 });
    expect(by.id).toEqual({ cases: 1, accuracy: 1 });
  });

  it("answer scoring: noul threshold at 0.5, rerank by candidate key", () => {
    expect(scoreRelevanceAnswer(0.92, true)).toBe(true);
    expect(scoreRelevanceAnswer(0.92, false)).toBe(false);
    expect(scoreRelevanceAnswer(0.3, false)).toBe(true);
    expect(scoreRelevanceAnswer(undefined, true)).toBe(false);
    expect(scoreRelevanceAnswer(Number.NaN, true)).toBe(false);
    expect(scoreCitationAnswer(0.1, false)).toBe(true);
    expect(scoreRerankAnswer("c1", 1)).toBe(true);
    expect(scoreRerankAnswer("c0", 1)).toBe(false);
    expect(scoreRerankAnswer(undefined, 0)).toBe(false);
  });
});

describe("decision gate", () => {
  it("passes when overall and every scored language clear the floors", () => {
    const outcomes = [
      ...Array.from({ length: 9 }, (_, i) => outcome(`rel-id-${i}`, "id", true)),
      outcome("rel-id-x", "id", false),
      ...Array.from({ length: 4 }, (_, i) => outcome(`rr-ar-${i}`, "ar", true)),
      ...Array.from({ length: 4 }, (_, i) => outcome(`cit-en-${i}`, "en", i < 3)),
    ];
    const gate = evaluateDecisionGate(outcomes);
    expect(gate.gatePass).toBe(true);
    expect(gate.failedLanguages).toEqual([]);
  });

  it("fails when one language falls under the per-language floor", () => {
    const outcomes = [
      ...Array.from({ length: 9 }, (_, i) => outcome(`rel-id-${i}`, "id", true)),
      // ar: 1/4 — well under 0.75
      outcome("rel-ar-1", "ar", true),
      ...Array.from({ length: 3 }, (_, i) => outcome(`rel-ar-${i + 2}`, "ar", false)),
    ];
    const gate = evaluateDecisionGate(outcomes);
    expect(gate.gatePass).toBe(false);
    expect(gate.failedLanguages).toEqual(["ar"]);
  });

  it("does not score a language with too few cases for or against the floor", () => {
    const outcomes = [
      ...Array.from({ length: 9 }, (_, i) => outcome(`rel-id-${i}`, "id", true)),
      // ar has 1 case (below minCasesPerLanguage) and it fails — reported,
      // not counted against the gate.
      outcome("rel-ar-1", "ar", false),
    ];
    const gate = evaluateDecisionGate(outcomes);
    expect(gate.gatePass).toBe(true);
    expect(accuracyByLanguage(outcomes).ar?.cases).toBe(1);
    expect(DECISION_GATE_FLOORS.minCasesPerLanguage).toBe(3);
  });
});

describe("decision-bench fixture loading", () => {
  const valid = {
    id: "b-v0",
    status: "v0-draft",
    relevance: [{ id: "rel-ar-1", language: "ar", query: "q", passage: "p", relevant: true }],
    rerank: [{ id: "rr-ar-1", language: "ar", query: "q", candidates: ["a", "b"], bestIndex: 0 }],
    citation: [{ id: "cit-ar-1", language: "ar", claim: "c", passage: "p", supports: true }],
  };

  it("parses a well-formed fixture", () => {
    const set = parseDecisionBenchFixture(valid);
    expect(set.relevance[0]?.relevant).toBe(true);
    expect(set.rerank[0]?.candidates).toHaveLength(2);
  });

  it("fails a malformed fixture loudly, never a silent skip", () => {
    expect(() => parseDecisionBenchFixture({ ...valid, relevance: [] })).not.toThrow();
    // Cross-field check: bestIndex outside the candidate list fails the load.
    expect(() =>
      parseDecisionBenchFixture({
        ...valid,
        rerank: [
          { id: "x", language: "ar", query: "q", candidates: ["a", "b", "c"], bestIndex: 5 },
        ],
      }),
    ).toThrow(/bestIndex 5 outside its 3 candidates/);
    expect(() => loadDecisionBenchFixtureJson("{not json")).toThrow(/invalid JSON/);
  });

  it("config loader validates the budget cap and resolves default paths", () => {
    const cfg = loadDecisionBenchConfig({});
    expect(cfg.budgetCapMicroUsd).toBeUndefined();
    expect(cfg.fixturePath).toBe(DECISION_BENCH_DEFAULT_FIXTURE_PATH);
    expect(cfg.reportPath).toContain("decision-bench-results.json");
    expect(() => loadDecisionBenchConfig({ EVAL_BUDGET_MICRO_USD: "abc" })).toThrow(
      /non-negative integer/,
    );
    expect(() => loadDecisionBenchConfig({ EVAL_BUDGET_MICRO_USD: "" })).toThrow(
      /non-negative integer/,
    );
    expect(loadDecisionBenchConfig({ EVAL_BUDGET_MICRO_USD: "0" }).budgetCapMicroUsd).toBe(0);
    expect(
      loadDecisionBenchConfig({ DECISION_BENCH_FIXTURE_PATH: "custom.json" }).fixturePath,
    ).toBe("custom.json");
  });
});
