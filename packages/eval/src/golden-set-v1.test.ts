/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { GoldenQuestion } from "@app/contracts";
import { loadGoldenSetJson } from "./golden-set";

/**
 * Golden Set v1 (fixture slice) — the engine-side structural checks.
 *
 * This test loads the fixture through the engine loader and pins the set's
 * identity, the carried v0 block in order, the citation shape and question uniqueness.
 * Coverage classes and source-type floors belong to the domain pack, whose own
 * test reads the same fixture and names its vocabulary; this engine test
 * deliberately names none of it.
 */

type RawQuestion = GoldenQuestion & { $comment?: string };
type RawFixture = { id: string; status: string; questions: RawQuestion[] };

const ROOT = new URL("../../../", import.meta.url);
const V1_URL = new URL("packages/kajianq-domain/fixtures/golden-set-v1.json", ROOT);
const V0_URL = new URL("packages/kajianq-domain/fixtures/golden-set-v0.json", ROOT);

const V1_TEXT = readFileSync(V1_URL, "utf8");
const SET = loadGoldenSetJson(V1_TEXT, "golden-set-v1.json");
const RAW = JSON.parse(V1_TEXT) as RawFixture;
const V0 = JSON.parse(readFileSync(V0_URL, "utf8")) as RawFixture;
const RAW_BY_ID = new Map(RAW.questions.map((question) => [question.id, question]));

function addedQuestions(): GoldenQuestion[] {
  return SET.questions.filter((question) => question.id.startsWith("gs-v1-"));
}

describe("golden-set-v1 fixture identity", () => {
  it("loads exactly fifty questions with unique ids", () => {
    expect(SET.id).toBe("golden-set-v1");
    expect(SET.status).toBe("v0-draft");
    expect(SET.questions).toHaveLength(50);
    const ids = SET.questions.map((question) => question.id);
    expect(new Set(ids).size).toBe(50);
    expect(ids.filter((id) => id.startsWith("gs-v0-"))).toHaveLength(21);
    expect(ids.filter((id) => id.startsWith("gs-v1-"))).toEqual(
      Array.from({ length: 29 }, (_, index) => `gs-v1-${String(index + 1).padStart(3, "0")}`),
    );
  });

  it("carries the v0 block unchanged and in order", () => {
    expect(V0.questions).toHaveLength(21);
    expect(RAW.questions.slice(0, V0.questions.length)).toEqual(V0.questions);
  });
});

describe("golden-set-v1 citation shape", () => {
  it("puts at least one required citation on every newly added answer row", () => {
    const uncited = addedQuestions()
      .filter(
        (question) =>
          question.expectedBehavior === "answer" && question.requiredCitations.length === 0,
      )
      .map((question) => question.id);
    expect(uncited).toEqual([]);
  });

  it("keeps every required citation a non-empty label", () => {
    const empty = SET.questions.flatMap((question) =>
      question.requiredCitations
        .filter((citation) => citation.trim() === "")
        .map((citation) => `${question.id}: "${citation}"`),
    );
    expect(empty).toEqual([]);
  });

  it("leaves every refusal row citation-free", () => {
    // The carried v0 answer row gs-v0-018 is deliberately citation-free; the
    // new-row rule above is what keeps that legacy shape from spreading.
    const cited = SET.questions
      .filter(
        (question) =>
          question.expectedBehavior === "refuse" && question.requiredCitations.length > 0,
      )
      .map((question) => question.id);
    expect(cited).toEqual([]);
  });

  it("records an evidence note on every newly curated row", () => {
    const missing = addedQuestions()
      .filter((question) => (RAW_BY_ID.get(question.id)?.$comment ?? "").trim() === "")
      .map((question) => question.id);
    expect(missing).toEqual([]);
  });
});

describe("golden-set-v1 question text", () => {
  it("has no duplicate question text", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const question of SET.questions) {
      const key = question.question.trim().replace(/\s+/g, " ").toLowerCase();
      const prior = seen.get(key);
      if (prior === undefined) {
        seen.set(key, question.id);
      } else {
        duplicates.push(`${prior} and ${question.id}`);
      }
    }
    expect(duplicates).toEqual([]);
  });
});
