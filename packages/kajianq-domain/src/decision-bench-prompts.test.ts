import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDecisionBenchFixture } from "@app/contracts";
import { DECISION_BENCH_PROMPTS } from "./decision-bench-prompts";

/**
 * The checked-in fixture must stay valid against the shared contract — a
 * fixture that drifts from the schema fails here, not at bench time after
 * spend. And the prompt templates must be structurally compatible with the
 * eval engine's DecisionBenchPrompts shape (checked structurally: the
 * domain pack must not import @app/eval — dependency direction).
 */

const FIXTURE_PATH = new URL("../fixtures/decision-bench-v0.json", import.meta.url);

// The structural shape the eval engine expects (duplicated from
// @app/eval's DecisionBenchPrompts — the domain pack cannot import it).
type PromptsShape = {
  relevance: {
    instructions: (c: {
      id: string;
      language: string;
      query: string;
      passage: string;
      relevant: boolean;
    }) => string;
    criteria: { true: string; false: string };
  };
  rerank: {
    instructions: (c: {
      id: string;
      language: string;
      query: string;
      candidates: string[];
      bestIndex: number;
    }) => string;
    criteria: (c: {
      id: string;
      language: string;
      query: string;
      candidates: string[];
      bestIndex: number;
    }) => Record<string, string | null>;
  };
  citation: {
    instructions: (c: {
      id: string;
      language: string;
      claim: string;
      passage: string;
      supports: boolean;
    }) => string;
    criteria: { true: string; false: string };
  };
};

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
    const prompts: PromptsShape = DECISION_BENCH_PROMPTS;
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
