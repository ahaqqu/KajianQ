import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * The v0 Golden Set's curated membership, pinned as data. A question id is the
 * key persisted `eval_results` rows reference, so an id is never reused: a
 * retired question leaves the set and its replacement takes the next id. The
 * exact id list makes every add, removal, or id swap a deliberate test change
 * rather than an incidental diff.
 */
type FixtureQuestion = {
  id: string;
  question: string;
  language: string;
  expectedSourceTypes: string[];
  requiredCitations: string[];
  expectedBehavior: string;
  tags?: string[];
};

const FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/golden-set-v0.json", import.meta.url), "utf8"),
) as { questions: FixtureQuestion[] };

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

describe("golden-set-v0 curation", () => {
  it("holds 21 questions with distinct ids and no reuse of a retired id", () => {
    const ids = FIXTURE.questions.map((question) => question.id);
    expect(FIXTURE.questions).toHaveLength(21);
    expect(ids).toEqual(IDS);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("gs-v0-007");
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
