/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { GoldenQuestion } from "@app/contracts";
import { loadGoldenSetJson } from "./golden-set";

/**
 * Golden Set v1 (fixture slice): 21 v0 rows carried unchanged plus 29 newly
 * curated rows. This file pins the fixture's identity, the v0 subset's
 * immutability, the coverage the draft claims, and the citation shape the eval
 * gate relies on. It reads the domain fixture as DATA and imports no domain
 * module, so the engine package stays vocabulary-free; the tag strings below
 * are the fixture's own opaque labels, named here only to count them.
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

/** The fixture's trap/coverage labels, treated as opaque strings. */
const TAGS = {
  quotation: "fabricated-attribution",
  dhaif: "dhaif-trap",
  crossMadzhab: "cross-madzhab",
  grade: "grade-check",
  tafsir: "tafsir",
} as const;

/** The newly curated rows that ask for an isnad rather than only a matn. */
const CHAIN_IDS = ["gs-v1-010", "gs-v1-011", "gs-v1-012"] as const;

function idsWhere(predicate: (question: GoldenQuestion) => boolean): string[] {
  return SET.questions.filter(predicate).map((question) => question.id);
}

function hasTag(question: GoldenQuestion, tag: string): boolean {
  return (question.tags ?? []).includes(tag);
}

function hasSource(question: GoldenQuestion, source: string): boolean {
  return question.expectedSourceTypes.includes(source);
}

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

  it("carries every v0 question unchanged, field for field", () => {
    expect(V0.questions).toHaveLength(21);
    for (const before of V0.questions) {
      expect(RAW_BY_ID.get(before.id), before.id).toEqual(before);
    }
  });
});

describe("golden-set-v1 coverage", () => {
  it("meets every coverage floor the slice claims", () => {
    expect(idsWhere((question) => question.language === "id")).toHaveLength(37);
    expect(idsWhere((question) => question.language === "en")).toHaveLength(13);
    expect(idsWhere((question) => question.expectedBehavior === "refuse")).toHaveLength(8);
    expect(idsWhere((question) => hasTag(question, TAGS.dhaif))).toHaveLength(4);
    expect(idsWhere((question) => hasTag(question, TAGS.crossMadzhab))).toHaveLength(4);
    expect(idsWhere((question) => hasSource(question, "hadith"))).toHaveLength(27);
    expect(idsWhere((question) => hasSource(question, "quran"))).toHaveLength(17);
    expect(idsWhere((question) => hasTag(question, TAGS.tafsir))).toHaveLength(8);
    expect(idsWhere((question) => hasTag(question, TAGS.grade))).toHaveLength(5);
    expect(idsWhere((question) => hasTag(question, TAGS.quotation))).toHaveLength(6);
  });

  it("pins at least three newly curated chain rows grounded in narrator_chains", () => {
    for (const id of CHAIN_IDS) {
      const row = RAW_BY_ID.get(id);
      expect(row, id).toBeDefined();
      expect(row?.expectedSourceTypes, id).toContain("hadith");
      expect(row?.$comment, id).toMatch(/narrator_chains/);
    }
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

  it("records an evidence-basis $comment on every newly curated row", () => {
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
