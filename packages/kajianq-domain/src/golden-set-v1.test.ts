/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";
import { GoldenSetSchema, type GoldenQuestion } from "@app/contracts";
import { GOLDEN_SET_TAG_VOCABULARY } from "./taxonomy";

/**
 * Golden Set v1 coverage, pinned in the domain pack. The engine-side test in
 * `@app/eval` owns the loader and structural checks and names no domain
 * vocabulary; this test owns the class and source-type floors, the tag
 * vocabulary, and the chain-row evidence, so the product vocabulary stays where
 * it belongs.
 */

type RawQuestion = GoldenQuestion & { $comment?: string };

const RAW = JSON.parse(
  readFileSync(new URL("../fixtures/golden-set-v1.json", import.meta.url), "utf8"),
) as { id: string; status: string; questions: RawQuestion[] };
const FIXTURE = v.parse(GoldenSetSchema, RAW);
const RAW_BY_ID = new Map(RAW.questions.map((question) => [question.id, question]));

/** The newly curated rows that ask for an isnad rather than only a matn. */
const CHAIN_IDS = ["gs-v1-010", "gs-v1-011", "gs-v1-012"] as const;

function idsWhere(predicate: (question: GoldenQuestion) => boolean): string[] {
  return FIXTURE.questions.filter(predicate).map((question) => question.id);
}

function hasTag(question: GoldenQuestion, tag: string): boolean {
  return (question.tags ?? []).includes(tag);
}

function hasSource(question: GoldenQuestion, source: string): boolean {
  return question.expectedSourceTypes.includes(source);
}

describe("golden-set-v1 coverage", () => {
  it("meets every language, refusal and trap floor the slice claims", () => {
    expect(idsWhere((question) => question.language === "id")).toHaveLength(37);
    expect(idsWhere((question) => question.language === "en")).toHaveLength(13);
    expect(idsWhere((question) => question.expectedBehavior === "refuse")).toHaveLength(8);
    expect(idsWhere((question) => hasTag(question, "dhaif-trap"))).toHaveLength(4);
    expect(idsWhere((question) => hasTag(question, "cross-madzhab"))).toHaveLength(4);
    expect(idsWhere((question) => hasTag(question, "tafsir"))).toHaveLength(8);
    expect(idsWhere((question) => hasTag(question, "grade-check"))).toHaveLength(5);
    expect(idsWhere((question) => hasTag(question, "fabricated-attribution"))).toHaveLength(6);
  });

  it("meets both source-type floors", () => {
    expect(idsWhere((question) => hasSource(question, "hadith"))).toHaveLength(27);
    expect(idsWhere((question) => hasSource(question, "quran"))).toHaveLength(17);
  });

  it("keeps every newly curated tag inside the domain vocabulary", () => {
    const unknown = FIXTURE.questions
      .filter((question) => question.id.startsWith("gs-v1-"))
      .flatMap((question) =>
        (question.tags ?? [])
          .filter((tag) => !GOLDEN_SET_TAG_VOCABULARY.includes(tag))
          .map((tag) => `${question.id}: ${tag}`),
      );
    expect(unknown).toEqual([]);
  });

  it("pins three chain rows grounded in the recorded chain table", () => {
    for (const id of CHAIN_IDS) {
      const row = RAW_BY_ID.get(id);
      expect(row, id).toBeDefined();
      expect(row?.expectedSourceTypes, id).toContain("hadith");
      expect(row?.$comment, id).toMatch(/narrator_chains/);
    }
  });
});
