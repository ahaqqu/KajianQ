import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { GoldenQuestion } from "@app/contracts";

/**
 * The v0 Golden Set's curated membership, pinned as data. A question id is the
 * key persisted `eval_results` rows reference, so an id is never reused: a
 * retired question leaves the set and its replacement takes the next id. The
 * exact id list makes every add, removal, or id swap a deliberate test change
 * rather than an incidental diff. Each row's requirement is pinned for the same
 * reason: a row no replay recorded has no other guard against a silent re-label.
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/golden-set-v0.json", import.meta.url), "utf8"),
) as { questions: GoldenQuestion[] };

const IDS = [
  "gs-v0-001",
  "gs-v0-002",
  "gs-v0-003",
  "gs-v0-004",
  "gs-v0-005",
  "gs-v0-006",
  "gs-v0-008",
  "gs-v0-009",
  "gs-v0-010",
  "gs-v0-011",
  "gs-v0-012",
  "gs-v0-013",
  "gs-v0-014",
  "gs-v0-015",
  "gs-v0-016",
  "gs-v0-017",
  "gs-v0-018",
  "gs-v0-019",
  "gs-v0-020",
  "gs-v0-021",
  "gs-v0-022",
];

/** Retired ids. Kept as a list, so a retirement edits the membership pin by
 * removing an entry here rather than adding another scattered literal. */
const RETIRED_IDS = ["gs-v0-007"];

/** The fields a row's gate behaviour is read from. */
type CuratedRequirement = Pick<
  GoldenQuestion,
  "expectedSourceTypes" | "requiredCitations" | "expectedBehavior" | "citationAlternatives"
>;

/** Every head row's requirement, pinned by id so no row's demand can drift
 * silently: the replay covers only the rows its run recorded. */
const REQUIREMENTS: Record<string, CuratedRequirement> = {
  "gs-v0-001": {
    expectedSourceTypes: ["quran"],
    requiredCitations: ["QS. 2:255"],
    expectedBehavior: "answer",
  },
  "gs-v0-002": {
    expectedSourceTypes: ["quran"],
    requiredCitations: ["QS. 2:43"],
    expectedBehavior: "answer",
  },
  "gs-v0-003": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Bukhari no. 191"],
    expectedBehavior: "answer",
  },
  "gs-v0-004": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Ibnu Majah no. 224"],
    expectedBehavior: "answer",
  },
  "gs-v0-005": {
    expectedSourceTypes: ["quran"],
    requiredCitations: ["QS. 112:1"],
    expectedBehavior: "answer",
  },
  "gs-v0-006": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Bukhari no. 1108"],
    expectedBehavior: "answer",
  },
  "gs-v0-008": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Bukhari no. 5026"],
    citationAlternatives: ["HR. Bukhari no. 5027", "HR. Bukhari no. 4937"],
    expectedBehavior: "answer",
  },
  "gs-v0-009": {
    expectedSourceTypes: ["quran"],
    requiredCitations: ["QS. 89:28"],
    expectedBehavior: "answer",
  },
  "gs-v0-010": {
    expectedSourceTypes: ["quran", "hadith"],
    requiredCitations: ["QS. 2:275"],
    expectedBehavior: "answer",
  },
  "gs-v0-011": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Muslim no. 534"],
    expectedBehavior: "answer",
  },
  "gs-v0-012": {
    expectedSourceTypes: ["quran"],
    requiredCitations: ["QS. 1:1"],
    expectedBehavior: "answer",
  },
  "gs-v0-013": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Muslim no. 5265"],
    expectedBehavior: "answer",
  },
  "gs-v0-014": {
    expectedSourceTypes: ["quran"],
    requiredCitations: ["QS. 98:5"],
    expectedBehavior: "answer",
  },
  "gs-v0-015": {
    expectedSourceTypes: ["quran", "hadith"],
    requiredCitations: ["QS. 1:2"],
    expectedBehavior: "answer",
  },
  "gs-v0-016": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Bukhari no. 1395"],
    expectedBehavior: "answer",
  },
  "gs-v0-017": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Nasai no. 5144"],
    expectedBehavior: "answer",
  },
  "gs-v0-018": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: [],
    expectedBehavior: "answer",
  },
  "gs-v0-019": {
    expectedSourceTypes: [],
    requiredCitations: [],
    expectedBehavior: "refuse",
  },
  "gs-v0-020": {
    expectedSourceTypes: [],
    requiredCitations: [],
    expectedBehavior: "refuse",
  },
  "gs-v0-021": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Bukhari no. 191"],
    expectedBehavior: "answer",
  },
  "gs-v0-022": {
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Bukhari no. 5971"],
    expectedBehavior: "answer",
  },
};

/** The requirement as the fixture carries it, in the pinned shape. */
function requirementOf(question: GoldenQuestion): CuratedRequirement {
  const { expectedSourceTypes, requiredCitations, expectedBehavior, citationAlternatives } =
    question;
  return citationAlternatives === undefined
    ? { expectedSourceTypes, requiredCitations, expectedBehavior }
    : { expectedSourceTypes, requiredCitations, citationAlternatives, expectedBehavior };
}

describe("golden-set-v0 curation", () => {
  it("holds 21 questions with distinct ids and no reuse of a retired id", () => {
    const ids = FIXTURE.questions.map((question) => question.id);
    expect(FIXTURE.questions).toHaveLength(21);
    expect(ids).toEqual(IDS);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => RETIRED_IDS.includes(id))).toEqual([]);
  });

  it("pins every row's requirement, so no row can be re-labelled silently", () => {
    expect(
      Object.fromEntries(
        FIXTURE.questions.map((question) => [question.id, requirementOf(question)]),
      ),
    ).toEqual(REQUIREMENTS);
  });

  it("carries the family/birr replacement as a new id, grounded on the Bukhari narration", () => {
    expect(FIXTURE.questions.find((question) => question.id === "gs-v0-022")).toEqual({
      id: "gs-v0-022",
      question: "Siapa yang harus diutamakan: istri atau ibu?",
      language: "id",
      expectedSourceTypes: ["hadith"],
      requiredCitations: ["HR. Bukhari no. 5971"],
      expectedBehavior: "answer",
      tags: ["adab", "hadith"],
    });
  });
});
