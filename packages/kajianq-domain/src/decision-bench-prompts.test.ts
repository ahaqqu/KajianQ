import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { parseDecisionBenchFixture, type DecisionBenchPrompts } from "@app/contracts";
import {
  DECISION_BENCH_PROMPTS,
  DECISION_BENCH_PROMPTS_IDENTITY,
  CITATION_INSTRUCTIONS,
  RERANK_INSTRUCTIONS,
  RELEVANCE_CRITERIA,
  RELEVANCE_INSTRUCTIONS,
} from "./decision-bench-prompts";

/**
 * The bench store's sealed case set must stay valid against the shared
 * contract — a fixture that drifts from the schema fails here, not at bench
 * time after spend. The prompt templates are typed by the shared contracts
 * type (DecisionBenchPrompts), so a drift from the engine's expected shape
 * is a compile error here, not a bench-time surprise.
 */

const FIXTURE_PATH = new URL("../../../benchmarks/decisions/samples/cases.json", import.meta.url);

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

  it("the wording identity carries every template's canonical text", () => {
    const identity = JSON.parse(DECISION_BENCH_PROMPTS_IDENTITY) as {
      relevance: { instructions: string };
      rerank: { instructions: string };
      citation: { instructions: string };
    };
    expect(identity.relevance.instructions).toBe(RELEVANCE_INSTRUCTIONS);
    expect(identity.rerank.instructions).toBe(RERANK_INSTRUCTIONS);
    expect(identity.citation.instructions).toBe(CITATION_INSTRUCTIONS);
    // A wording change must move the pin every run file carries — if the
    // identity ever stopped depending on a constant, runs would silently
    // share a stale pin.
    expect(DECISION_BENCH_PROMPTS_IDENTITY).toContain(RELEVANCE_CRITERIA.true);
  });
});
