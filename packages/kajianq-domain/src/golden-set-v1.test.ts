/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";
import { GoldenSetSchema, type GoldenQuestion } from "@app/contracts";
import { normalizeCitationLabel } from "./chat-citation-normalize";
import { parseHadithCitation } from "./hadith-source";
import { GOLDEN_SET_TAG_VOCABULARY, SMOKE_HELD_OUT_IDS } from "./taxonomy";

/**
 * Golden Set v1 coverage, pinned in the domain pack. The engine-side test in
 * `@app/eval` owns the loader and structural checks and names no domain
 * vocabulary; this test owns the class and source-type membership, the tag
 * vocabulary, the corpus-label registration and the chain-row evidence, so the
 * product vocabulary stays where it belongs.
 */

type RawQuestion = GoldenQuestion & { $comment?: string };

type CorpusLabel = {
  label: string;
  collection: string;
  hadithNo: string;
  grade: string | null;
  arabicEdition: string;
  arabicEditionSha256: string;
  indonesianEdition: string;
  indonesianEditionSha256: string;
};

const RAW = JSON.parse(
  readFileSync(new URL("../fixtures/golden-set-v1.json", import.meta.url), "utf8"),
) as { id: string; status: string; questions: RawQuestion[] };
const FIXTURE = v.parse(GoldenSetSchema, RAW);
const RAW_BY_ID = new Map(RAW.questions.map((question) => [question.id, question]));
const V0 = JSON.parse(
  readFileSync(new URL("../fixtures/golden-set-v0.json", import.meta.url), "utf8"),
) as { questions: GoldenQuestion[] };

const CORPUS_LABELS = JSON.parse(
  readFileSync(new URL("../fixtures/hadith-corpus-labels-v0.json", import.meta.url), "utf8"),
) as { labels: CorpusLabel[] };
const CORPUS_BY_LABEL = new Map(
  CORPUS_LABELS.labels.map((entry) => [normalizeCitationLabel(entry.label), entry]),
);

/** The newly curated rows that ask for an isnad rather than only a matn. */
const CHAIN_IDS = ["gs-v1-010", "gs-v1-011", "gs-v1-012"] as const;

/**
 * The v0 smoke rows the deployed gate does not sample, with every required or
 * opted-in label they carry. A new row may not reuse one of these labels.
 */
const HELD_OUT_LABELS = new Set(
  V0.questions
    .filter((question) => SMOKE_HELD_OUT_IDS.includes(question.id))
    .flatMap((question) => [
      ...question.requiredCitations,
      ...(question.citationAlternatives ?? []),
    ]),
);

/** Every trap and source class, pinned by row membership rather than by count. */
const EXPECTED_IDS = {
  quotation: ["gs-v0-020", "gs-v1-001", "gs-v1-002", "gs-v1-003", "gs-v1-004", "gs-v1-005"],
  dhaif: ["gs-v0-020", "gs-v1-013", "gs-v1-014", "gs-v1-015"],
  cross: ["gs-v0-018", "gs-v1-007", "gs-v1-008", "gs-v1-009"],
  chain: [...CHAIN_IDS],
  tafsir: [
    "gs-v0-009",
    "gs-v0-014",
    "gs-v1-006",
    "gs-v1-016",
    "gs-v1-017",
    "gs-v1-018",
    "gs-v1-019",
    "gs-v1-020",
  ],
  grade: ["gs-v0-004", "gs-v0-011", "gs-v1-013", "gs-v1-014", "gs-v1-015"],
  refusal: [
    "gs-v0-019",
    "gs-v0-020",
    "gs-v1-001",
    "gs-v1-002",
    "gs-v1-003",
    "gs-v1-004",
    "gs-v1-005",
    "gs-v1-006",
  ],
  hadith: [
    "gs-v0-003",
    "gs-v0-004",
    "gs-v0-006",
    "gs-v0-008",
    "gs-v0-010",
    "gs-v0-011",
    "gs-v0-013",
    "gs-v0-015",
    "gs-v0-016",
    "gs-v0-017",
    "gs-v0-018",
    "gs-v0-021",
    "gs-v0-022",
    "gs-v1-007",
    "gs-v1-008",
    "gs-v1-009",
    "gs-v1-010",
    "gs-v1-011",
    "gs-v1-012",
    "gs-v1-013",
    "gs-v1-014",
    "gs-v1-015",
    "gs-v1-025",
    "gs-v1-026",
    "gs-v1-027",
    "gs-v1-028",
    "gs-v1-029",
  ],
  quran: [
    "gs-v0-001",
    "gs-v0-002",
    "gs-v0-005",
    "gs-v0-009",
    "gs-v0-010",
    "gs-v0-012",
    "gs-v0-014",
    "gs-v0-015",
    "gs-v1-016",
    "gs-v1-017",
    "gs-v1-018",
    "gs-v1-019",
    "gs-v1-020",
    "gs-v1-021",
    "gs-v1-022",
    "gs-v1-023",
    "gs-v1-024",
  ],
} as const;

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
  it("meets every language floor the slice claims", () => {
    expect(idsWhere((question) => question.language === "id")).toHaveLength(37);
    expect(idsWhere((question) => question.language === "en")).toHaveLength(13);
  });

  it("pins the exact membership of every trap and source class", () => {
    expect(idsWhere((question) => hasTag(question, "fabricated-attribution"))).toEqual(
      EXPECTED_IDS.quotation,
    );
    expect(idsWhere((question) => hasTag(question, "dhaif-trap"))).toEqual(EXPECTED_IDS.dhaif);
    expect(idsWhere((question) => hasTag(question, "cross-madzhab"))).toEqual(EXPECTED_IDS.cross);
    expect(idsWhere((question) => hasTag(question, "tafsir"))).toEqual(EXPECTED_IDS.tafsir);
    expect(idsWhere((question) => hasTag(question, "grade-check"))).toEqual(EXPECTED_IDS.grade);
    expect(idsWhere((question) => question.expectedBehavior === "refuse")).toEqual(
      EXPECTED_IDS.refusal,
    );
    expect(idsWhere((question) => hasSource(question, "hadith"))).toEqual(EXPECTED_IDS.hadith);
    expect(idsWhere((question) => hasSource(question, "quran"))).toEqual(EXPECTED_IDS.quran);
  });

  it("uses only the source types the staged corpus carries", () => {
    const allowed = new Set(["quran", "hadith"]);
    const unexpected = FIXTURE.questions.flatMap((question) =>
      question.expectedSourceTypes
        .filter((source) => !allowed.has(source))
        .map((source) => `${question.id}: ${source}`),
    );
    expect(unexpected).toEqual([]);
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

describe("golden-set-v1 corpus registration and gate shape", () => {
  it("registers every required hadith label on a new answer row", () => {
    const missing: string[] = [];
    const answerRows = FIXTURE.questions.filter(
      (question) => question.id.startsWith("gs-v1-") && question.expectedBehavior === "answer",
    );

    for (const row of answerRows) {
      for (const raw of row.requiredCitations) {
        const label = normalizeCitationLabel(raw);
        const parsed = parseHadithCitation(label);
        if (parsed === null) continue;

        const entry = CORPUS_BY_LABEL.get(label);
        if (entry === undefined) {
          missing.push(`${row.id}: ${raw}`);
          continue;
        }

        expect(
          { collection: entry.collection, hadithNo: entry.hadithNo },
          `${row.id}: ${raw}`,
        ).toEqual({ collection: parsed.collection, hadithNo: parsed.hadithNo });
        expect(entry.arabicEdition, label).not.toBe("");
        expect(entry.arabicEditionSha256, label).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.indonesianEdition, label).not.toBe("");
        expect(entry.indonesianEditionSha256, label).toMatch(/^[0-9a-f]{64}$/);
      }
    }

    expect(missing).toEqual([]);
  });

  it("keeps new rows off the labels a held-out smoke row requires", () => {
    expect(HELD_OUT_LABELS.size).toBeGreaterThan(0);
    const reused = FIXTURE.questions
      .filter((question) => question.id.startsWith("gs-v1-"))
      .flatMap((question) =>
        question.requiredCitations
          .filter((citation) => HELD_OUT_LABELS.has(citation))
          .map((citation) => `${question.id}: ${citation}`),
      );
    expect(reused).toEqual([]);
  });

  it("pins the trivially-satisfied citation shape of every refusal row", () => {
    // The current acceptance rule also accepts a grounded non-refusal for a
    // `refuse` row. Empty required citations and expected source types make
    // citation validity and both recall dimensions 1, so these rows test
    // non-affirmation and non-invention, not a literal refusal. Changing that
    // acceptance rule is an engine decision, out of scope for this data slice.
    const refusals = FIXTURE.questions.filter((question) => question.expectedBehavior === "refuse");
    expect(refusals.length).toBeGreaterThan(0);
    for (const row of refusals) {
      expect(row.requiredCitations, row.id).toEqual([]);
      expect(row.expectedSourceTypes, row.id).toEqual([]);
    }
  });
});
