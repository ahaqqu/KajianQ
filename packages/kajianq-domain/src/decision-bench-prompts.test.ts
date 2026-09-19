import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDecisionBenchFixture, type DecisionBenchPrompts } from "@app/contracts";
import { DECISION_BENCH_PROMPTS } from "./decision-bench-prompts";

/**
 * The checked-in fixture must stay valid against the shared contract — a
 * fixture that drifts from the schema fails here, not at bench time after
 * spend. The prompt templates are typed by the shared contracts type
 * (DecisionBenchPrompts), so a drift from the engine's expected shape is a
 * compile error here, not a bench-time surprise.
 */

const FIXTURE_PATH = new URL("../fixtures/decision-bench-v0.json", import.meta.url);

function loadFixture() {
  return parseDecisionBenchFixture(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
}

describe("decision-bench fixture", () => {
  it("loads through the contract schema", () => {
    const set = loadFixture();
    expect(set.id).toBe("decision-bench-v0");
    expect(set.status).toBe("v0-draft");
  });

  it("covers every content language with at least 4 cases", () => {
    const set = loadFixture();
    const perLanguage = new Map<string, number>();
    for (const c of [...set.relevance, ...set.rerank, ...set.citation]) {
      perLanguage.set(c.language, (perLanguage.get(c.language) ?? 0) + 1);
    }
    expect([...perLanguage.keys()].sort()).toEqual(["ar", "en", "id"]);
    for (const count of perLanguage.values()) {
      expect(count).toBeGreaterThanOrEqual(4);
    }
  });

  it("rerank bestIndex always points at a real candidate", () => {
    const set = loadFixture();
    for (const c of set.rerank) {
      expect(c.bestIndex).toBeLessThan(c.candidates.length);
      expect(c.bestIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it("prompt templates are structurally compatible with the engine's DecisionBenchPrompts", () => {
    const prompts: DecisionBenchPrompts = DECISION_BENCH_PROMPTS;
    expect(prompts.relevance.instructions).toBeTypeOf("function");
    expect(prompts.relevance.criteria.true).toBeTypeOf("string");
    expect(
      prompts.rerank.criteria({
        id: "x",
        language: "en",
        query: "q",
        candidates: ["a", "b"],
        bestIndex: 0,
      }),
    ).toEqual({});
  });
});
