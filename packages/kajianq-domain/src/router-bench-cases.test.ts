import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { parseRouterBenchFixture, type RouterBenchFixture } from "@app/contracts";
import { INTENTS, PRINCIPLE_TAGS, SUBJECT_AREAS } from "./taxonomy";

/**
 * The bench store's sealed routing cases must stay valid against the shared
 * contract, and the classification vocabularies they assert must be the
 * domain pack's own — a case asserting an intent or subject area the router
 * can never emit would score every model as a failure for the fixture's
 * sake, so it fails here, not at bench time after spend.
 */

const CASES_PATH = fileURLToPath(
  new URL("../../../benchmarks/routing/samples/cases.json", import.meta.url),
);

function loadFixture(): RouterBenchFixture {
  return parseRouterBenchFixture(JSON.parse(readFileSync(CASES_PATH, "utf8")));
}

describe("router-bench fixture", () => {
  it("loads through the contract schema", () => {
    const set = loadFixture();
    expect(set.id).toBe("router-bench-v0");
    expect(set.status).toBe("v0-draft");
  });

  it("asserted classifications are always in the router's own vocabulary", () => {
    const set = loadFixture();
    for (const c of set.cases) {
      expect(INTENTS, `${c.id} intent`).toContain(c.expected.intent);
      if (c.expected.category !== undefined) {
        expect(SUBJECT_AREAS, `${c.id} category`).toContain(c.expected.category);
      }
      if (c.expected.principleTags !== undefined) {
        for (const tag of c.expected.principleTags) {
          expect(PRINCIPLE_TAGS, `${c.id} tag`).toContain(tag);
        }
      }
    }
  });

  it("covers every content language with at least 3 cases (the gate's floor input)", () => {
    const set = loadFixture();
    const perLanguage = new Map<string, number>();
    for (const c of set.cases) {
      perLanguage.set(c.language, (perLanguage.get(c.language) ?? 0) + 1);
    }
    expect([...perLanguage.keys()].sort()).toEqual(["ar", "en", "id"]);
    for (const count of perLanguage.values()) {
      expect(count).toBeGreaterThanOrEqual(3);
    }
  });

  it("asserts needsPrinciple both ways — a fixture that only ever asserts true lies", () => {
    const set = loadFixture();
    const asserted = set.cases
      .filter((c) => c.expected.needsPrinciple !== undefined)
      .map((c) => c.expected.needsPrinciple);
    expect(asserted).toContain(true);
    expect(asserted).toContain(false);
  });

  it("every intent in the vocabulary is exercised by at least one case", () => {
    const set = loadFixture();
    const seen = new Set(set.cases.map((c) => c.expected.intent));
    for (const intent of INTENTS) {
      expect(seen, `intent ${intent}`).toContain(intent);
    }
  });
});
