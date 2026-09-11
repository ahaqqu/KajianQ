import { describe, expect, it } from "vitest";
import type { GoldenSet } from "@app/contracts";
import { selectSmokeSubset } from "./smoke-subset";

/**
 * Smoke-subset selection (ticket #10 AC). The selector's job is coverage, not
 * sampling: a subset that missed the refusal and trap cases would let a PR
 * pass while exactly the behaviour this ticket protects regressed. These
 * tests pin that guarantee, plus determinism (same input ⇒ same subset).
 */

const set: GoldenSet = {
  id: "golden-set-v0",
  status: "v0-draft",
  questions: [
    {
      id: "q-id-1",
      question: "What does verse 2:255 say?",
      language: "id",
      expectedSourceTypes: ["primary-source"],
      requiredCitations: ["label-1"],
      expectedBehavior: "answer",
      tags: ["topic-a"],
    },
    {
      id: "q-id-2",
      question: "A narration about intention?",
      language: "id",
      expectedSourceTypes: ["secondary-source"],
      requiredCitations: [],
      expectedBehavior: "answer",
      tags: ["topic-b"],
    },
    {
      id: "q-en-1",
      question: "What is verse 2:255?",
      language: "en",
      expectedSourceTypes: ["primary-source"],
      requiredCitations: ["label-1"],
      expectedBehavior: "answer",
      tags: ["english"],
    },
    {
      id: "q-refuse-1",
      question: "Unanswerable question",
      language: "id",
      expectedSourceTypes: [],
      requiredCitations: [],
      expectedBehavior: "refuse",
      tags: ["refusal", "unanswerable"],
    },
    {
      id: "q-trap-1",
      question: "Fabricated attribution trap",
      language: "id",
      expectedSourceTypes: [],
      requiredCitations: [],
      expectedBehavior: "refuse",
      tags: ["refusal", "trap-tag", "fabricated-attribution"],
    },
    {
      id: "q-id-3",
      question: "Another Indonesian question",
      language: "id",
      expectedSourceTypes: ["primary-source"],
      requiredCitations: [],
      expectedBehavior: "answer",
      tags: ["topic-c"],
    },
  ],
};

describe("selectSmokeSubset", () => {
  it("always includes a refusal, a trap, an English, and an Indonesian case", () => {
    const { set: smoke } = selectSmokeSubset(set, { size: 5, trapTag: "trap-tag" });
    const ids = smoke.questions.map((q) => q.id);
    expect(ids).toContain("q-refuse-1");
    expect(ids).toContain("q-trap-1");
    expect(ids).toContain("q-en-1");
    expect(
      smoke.questions.some((q) => q.language === "id" && q.expectedBehavior === "answer"),
    ).toBe(true);
  });

  it("honors the size budget", () => {
    expect(selectSmokeSubset(set, { size: 2 }).set.questions).toHaveLength(2);
    expect(selectSmokeSubset(set, { size: 4, trapTag: "trap-tag" }).set.questions).toHaveLength(4);
    // Size larger than the set returns the whole set, never a padded duplicate.
    expect(selectSmokeSubset(set, { size: 99 }).set.questions).toHaveLength(set.questions.length);
  });

  it("prefers the refusal case even when size is 1", () => {
    const { set: smoke } = selectSmokeSubset(set, { size: 1 });
    expect(smoke.questions.map((q) => q.id)).toEqual(["q-refuse-1"]);
  });

  it("is deterministic: same input yields the same subset and order", () => {
    const a = selectSmokeSubset(set, { size: 4, trapTag: "trap-tag" });
    const b = selectSmokeSubset(set, { size: 4, trapTag: "trap-tag" });
    expect(a.set.questions.map((q) => q.id)).toEqual(b.set.questions.map((q) => q.id));
    expect(a.reasons).toEqual(b.reasons);
  });

  it("reports why each question was picked", () => {
    const { reasons } = selectSmokeSubset(set, { size: 4, trapTag: "trap-tag" });
    expect(reasons[0]?.reason).toBe("refusal coverage");
    expect(reasons[1]?.reason).toBe("trap coverage");
    expect(reasons[2]?.reason).toBe("English language coverage");
    expect(reasons[3]?.reason).toBe("Indonesian answer coverage");
  });

  it("marks the subset with a derived id so runs are distinguishable", () => {
    const { set: smoke } = selectSmokeSubset(set, { size: 3 });
    expect(smoke.id).toBe("golden-set-v0-smoke");
    // The source set is not mutated.
    expect(set.id).toBe("golden-set-v0");
    expect(set.questions).toHaveLength(6);
  });

  it("accepts a caller-supplied trap tag (the engine names no product vocabulary)", () => {
    const { set: smoke } = selectSmokeSubset(set, { size: 5, trapTag: "fabricated-attribution" });
    expect(smoke.questions.map((q) => q.id)).toContain("q-trap-1");
  });

  it("degrades gracefully when a coverage class is absent", () => {
    const noRefusal: GoldenSet = {
      ...set,
      questions: set.questions.filter((q) => q.expectedBehavior !== "refuse"),
    };
    const { set: smoke } = selectSmokeSubset(noRefusal, { size: 3 });
    expect(smoke.questions).toHaveLength(3);
    expect(smoke.questions.map((q) => q.id)).toContain("q-en-1");
  });

  it("never selects the same question twice", () => {
    const { set: smoke } = selectSmokeSubset(set, { size: 6 });
    const ids = smoke.questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
