import { describe, expect, it } from "vite-plus/test";
import type { GoldenSet } from "@app/contracts";
import { selectSmokeSubset, SmokeSubsetError, type SmokeSelectOptions } from "./smoke-subset";

/**
 * Smoke-subset selection. The selector's job is coverage, not sampling: a
 * subset that missed the refusal and the required label classes would let a PR
 * pass while exactly the behaviour these tests protect regressed. These tests
 * pin that guarantee, plus determinism (same input ⇒ same subset).
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
    {
      id: "q-coverage-1",
      question: "An answer question the product names a required class for",
      language: "id",
      expectedSourceTypes: ["secondary-source"],
      requiredCitations: [],
      expectedBehavior: "answer",
      tags: ["coverage-tag"],
    },
  ],
};

describe("selectSmokeSubset", () => {
  it("always includes a refusal, every required class, an English, and an Indonesian case", () => {
    const { set: smoke } = selectSmokeSubset(set, {
      size: 5,
      requiredTags: ["trap-tag", "coverage-tag"],
    });
    const ids = smoke.questions.map((q) => q.id);
    expect(ids).toContain("q-refuse-1");
    expect(ids).toContain("q-trap-1");
    expect(ids).toContain("q-coverage-1");
    expect(ids).toContain("q-en-1");
    expect(
      smoke.questions.some((q) => q.language === "id" && q.expectedBehavior === "answer"),
    ).toBe(true);
  });

  it("honors the size budget", () => {
    expect(selectSmokeSubset(set, { size: 2 }).set.questions).toHaveLength(2);
    expect(
      selectSmokeSubset(set, { size: 4, requiredTags: ["trap-tag"] }).set.questions,
    ).toHaveLength(4);
    // Size larger than the set returns the whole set, never a padded duplicate.
    expect(selectSmokeSubset(set, { size: 99 }).set.questions).toHaveLength(set.questions.length);
    // A required class beyond the budget cannot be added without exceeding it;
    // the refusal case keeps the first slot.
    expect(
      selectSmokeSubset(set, { size: 1, requiredTags: ["trap-tag"] }).set.questions.map(
        (q) => q.id,
      ),
    ).toEqual(["q-refuse-1"]);
  });

  it("prefers the refusal case even when size is 1", () => {
    const { set: smoke } = selectSmokeSubset(set, { size: 1 });
    expect(smoke.questions.map((q) => q.id)).toEqual(["q-refuse-1"]);
  });

  it("takes the required classes in the caller's order", () => {
    const { set: smoke } = selectSmokeSubset(set, {
      size: 5,
      requiredTags: ["coverage-tag", "trap-tag"],
    });
    expect(smoke.questions.map((q) => q.id)).toEqual([
      "q-refuse-1",
      "q-coverage-1",
      "q-trap-1",
      "q-en-1",
      "q-id-1",
    ]);
  });

  it("is deterministic: same input yields the same subset and order", () => {
    const opts = { size: 5, requiredTags: ["trap-tag", "coverage-tag"] };
    const a = selectSmokeSubset(set, opts);
    const b = selectSmokeSubset(set, opts);
    expect(a.set.questions.map((q) => q.id)).toEqual(b.set.questions.map((q) => q.id));
    expect(a.reasons).toEqual(b.reasons);
  });

  it("reports why each question was picked, naming each required tag", () => {
    const { reasons } = selectSmokeSubset(set, {
      size: 5,
      requiredTags: ["trap-tag", "coverage-tag"],
    });
    expect(reasons[0]?.reason).toBe("refusal coverage");
    expect(reasons[1]?.reason).toBe("required tag coverage: trap-tag");
    expect(reasons[2]?.reason).toBe("required tag coverage: coverage-tag");
    expect(reasons[3]?.reason).toBe("English language coverage");
    expect(reasons[4]?.reason).toBe("Indonesian answer coverage");
  });

  it("marks the subset with a derived id so runs are distinguishable", () => {
    const { set: smoke } = selectSmokeSubset(set, { size: 3 });
    expect(smoke.id).toBe("golden-set-v0-smoke");
    // The source set is not mutated.
    expect(set.id).toBe("golden-set-v0");
    expect(set.questions).toHaveLength(7);
  });

  it("accepts caller-supplied required tags (the engine names no product vocabulary)", () => {
    const { set: smoke } = selectSmokeSubset(set, {
      size: 5,
      requiredTags: ["fabricated-attribution"],
    });
    expect(smoke.questions.map((q) => q.id)).toContain("q-trap-1");
  });

  it("refuses a required tag the set does not carry instead of skipping the class", () => {
    // A tag that reached one side of a rename only: the selector must redden
    // the gate, never return a smaller subset that silently dropped the class.
    // The tag here is deliberately NOT a product vocabulary word — the engine
    // package names no domain value (dars-pluggability), and the defect under
    // test is the miss.
    expect(() => selectSmokeSubset(set, { size: 5, requiredTags: ["stale-tag"] })).toThrow(
      SmokeSubsetError,
    );
    expect(() => selectSmokeSubset(set, { size: 5, requiredTags: ["stale-tag"] })).toThrow(
      /no question in "golden-set-v0" carries the required tag "stale-tag"/,
    );
    // A tag that does match still selects, and an empty tag is not a class
    // request at all.
    expect(selectSmokeSubset(set, { size: 5, requiredTags: [""] }).set.questions).toHaveLength(5);
  });

  it("refuses an option it does not know instead of ignoring it", () => {
    // The staged smoke's `.mjs` entry is outside typecheck: a renamed option
    // would otherwise drop a required class while the run printed a clean plan.
    const renamed = { size: 5, trapTag: "trap-tag" } as unknown as SmokeSelectOptions;
    expect(() => selectSmokeSubset(set, renamed)).toThrow(SmokeSubsetError);
    expect(() => selectSmokeSubset(set, renamed)).toThrow(
      /unknown smoke-subset option "trapTag" \(known: size, requiredTags\)/,
    );
  });

  it("does not duplicate a required class the refusal slot already covers", () => {
    // A required tag carried by the already-selected refusal case is covered;
    // the class must not consume a second slot with another question.
    const tagged: GoldenSet = {
      ...set,
      questions: set.questions.map((q) =>
        q.id === "q-refuse-1" ? { ...q, tags: [...(q.tags ?? []), "refusal-tag"] } : q,
      ),
    };
    const { set: smoke } = selectSmokeSubset(tagged, {
      size: 5,
      requiredTags: ["refusal-tag", "trap-tag"],
    });
    expect(smoke.questions.map((q) => q.id)).toEqual([
      "q-refuse-1",
      "q-trap-1",
      "q-en-1",
      "q-id-1",
      "q-id-2",
    ]);
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
    const { set: smoke } = selectSmokeSubset(set, { size: 7 });
    const ids = smoke.questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
