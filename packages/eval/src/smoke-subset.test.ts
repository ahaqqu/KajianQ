import { describe, expect, it } from "vite-plus/test";
import type { GoldenSet } from "@app/contracts";
import {
  formatSmokePlan,
  selectSmokeSubset,
  SmokeSubsetError,
  type SmokeSelectOptions,
} from "./smoke-subset";

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

/**
 * Tag-heavy fixture: every required tag points at a refusal question, so the
 * budget can be consumed by tags and leave the language classes uncovered —
 * the failure a plan that only prints "required tag coverage" lines would hide.
 */
const taggedSet: GoldenSet = {
  id: "golden-set-v0-tagged",
  status: "v0-draft",
  questions: [
    {
      id: "tag-1",
      question: "First tagged refusal",
      language: "id",
      expectedSourceTypes: [],
      requiredCitations: [],
      expectedBehavior: "refuse",
      tags: ["tag-a"],
    },
    {
      id: "tag-2",
      question: "Second tagged refusal",
      language: "id",
      expectedSourceTypes: [],
      requiredCitations: [],
      expectedBehavior: "refuse",
      tags: ["tag-b"],
    },
    {
      id: "tag-3",
      question: "Third tagged refusal",
      language: "id",
      expectedSourceTypes: [],
      requiredCitations: [],
      expectedBehavior: "refuse",
      tags: ["tag-c"],
    },
    {
      id: "tag-en",
      question: "English answer",
      language: "en",
      expectedSourceTypes: ["primary-source"],
      requiredCitations: [],
      expectedBehavior: "answer",
      tags: [],
    },
    {
      id: "tag-id-answer",
      question: "Indonesian answer",
      language: "id",
      expectedSourceTypes: ["primary-source"],
      requiredCitations: [],
      expectedBehavior: "answer",
      tags: [],
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
    // Size 4 fits the refusal, the trap, English and the Indonesian answer;
    // size 3 fits the three classes that remain without a required tag. A
    // budget too small for a class the fixture carries throws (next test).
    expect(
      selectSmokeSubset(set, { size: 4, requiredTags: ["trap-tag"] }).set.questions,
    ).toHaveLength(4);
    expect(selectSmokeSubset(set, { size: 3 }).set.questions).toHaveLength(3);
    // Size larger than the set returns the whole set, never a padded duplicate.
    expect(selectSmokeSubset(set, { size: 99 }).set.questions).toHaveLength(set.questions.length);
  });

  it("refuses a budget that cannot cover every class the fixture carries", () => {
    // The refusal case keeps the first slot, but a subset that silently drops
    // the language classes is not the gate the selector promises: the run must
    // fail instead of printing a clean plan for a weaker subset.
    expect(() => selectSmokeSubset(set, { size: 1 })).toThrow(SmokeSubsetError);
    expect(() => selectSmokeSubset(set, { size: 1 })).toThrow(
      /size 1 cannot cover every class the available set carries/,
    );
    expect(() => selectSmokeSubset(set, { size: 1 })).toThrow(
      /missing: English language coverage, Indonesian answer coverage/,
    );
    // Size 2 buys English; the Indonesian answer class still does not fit.
    expect(() => selectSmokeSubset(set, { size: 2 })).toThrow(
      /size 2 cannot cover every class the available set carries .*missing: Indonesian answer coverage/,
    );
    // A required tag is a class too, but its question can also cover a
    // language class: the coverage-tag question is an Indonesian answer, so
    // size 3 leaves only English uncovered — the assertion reads `picked`.
    expect(() =>
      selectSmokeSubset(set, { size: 3, requiredTags: ["trap-tag", "coverage-tag"] }),
    ).toThrow(/missing: English language coverage; picked 3: q-refuse-1, q-trap-1, q-coverage-1/);
  });

  it("names the classes a tag-heavy budget pushes out", () => {
    // Three required tags consume the budget after the refusal slot: no room
    // for either language class at size 3, nor for the Indonesian answer case
    // at size 4.
    expect(() =>
      selectSmokeSubset(taggedSet, { size: 3, requiredTags: ["tag-a", "tag-b", "tag-c"] }),
    ).toThrow(
      /size 3 cannot cover every class the available set carries .*missing: English language coverage, Indonesian answer coverage/,
    );
    expect(() =>
      selectSmokeSubset(taggedSet, { size: 4, requiredTags: ["tag-a", "tag-b", "tag-c"] }),
    ).toThrow(
      /size 4 cannot cover every class the available set carries .*missing: Indonesian answer coverage/,
    );
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
      /unknown smoke-subset option "trapTag" \(known: size, requiredTags, exclude\)/,
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

  it("keeps a held-out question out of every class and fills the class from the rest", () => {
    const { set: smoke, reasons } = selectSmokeSubset(set, {
      size: 5,
      requiredTags: ["trap-tag"],
      exclude: ["q-id-1"],
    });
    // The excluded question was the first Indonesian answer; the class still
    // fills, from the next eligible question.
    expect(smoke.questions.map((q) => q.id)).not.toContain("q-id-1");
    expect(reasons.find((r) => r.reason === "Indonesian answer coverage")?.id).toBe("q-id-2");
  });

  it("reports a class whose carriers are all held out instead of throwing or filling it", () => {
    const { set: smoke, unavailable } = selectSmokeSubset(set, {
      size: 5,
      requiredTags: ["trap-tag"],
      exclude: ["q-en-1"],
    });
    expect(smoke.questions.map((q) => q.id)).not.toContain("q-en-1");
    expect(unavailable).toEqual([{ reason: "English language coverage", heldOut: ["q-en-1"] }]);
  });

  it("refuses an excluded id the set does not carry", () => {
    expect(() => selectSmokeSubset(set, { size: 5, exclude: ["q-missing"] })).toThrow(
      /excluded id\(s\) not in "golden-set-v0": q-missing/,
    );
  });

  it("refuses a required tag whose carriers are all held out", () => {
    expect(() =>
      selectSmokeSubset(set, { size: 5, requiredTags: ["trap-tag"], exclude: ["q-trap-1"] }),
    ).toThrow(/required tag "trap-tag" is carried only by held-out question\(s\) \(q-trap-1\)/);
  });

  it("leaves the caller's full set untouched", () => {
    const before = set.questions.map((q) => q.id);
    selectSmokeSubset(set, { size: 5, exclude: ["q-en-1"] });
    expect(set.questions.map((q) => q.id)).toEqual(before);
  });

  it("reports expected source types the sample no longer asks for", () => {
    const typedSet: GoldenSet = {
      ...set,
      questions: [
        ...set.questions,
        {
          id: "q-typed-1",
          question: "A third source type",
          language: "id",
          expectedSourceTypes: ["tertiary-source"],
          requiredCitations: [],
          expectedBehavior: "answer",
          tags: ["topic-d"],
        },
      ],
    };
    const selection = selectSmokeSubset(typedSet, { size: 5, requiredTags: ["trap-tag"] });
    expect(selection.uncoveredSourceTypes).toEqual(["tertiary-source"]);
  });

  it("prints the classes and source types the sample does not cover", () => {
    const typedSet: GoldenSet = {
      ...set,
      questions: [
        ...set.questions,
        {
          id: "q-typed-1",
          question: "A third source type",
          language: "id",
          expectedSourceTypes: ["tertiary-source"],
          requiredCitations: [],
          expectedBehavior: "answer",
          tags: ["topic-d"],
        },
      ],
    };
    const selection = selectSmokeSubset(typedSet, {
      size: 5,
      requiredTags: ["trap-tag"],
      exclude: ["q-en-1"],
    });
    const plan = formatSmokePlan(selection, typedSet).join("\n");
    expect(plan).toContain("not covered: English language coverage (held out: q-en-1)");
    expect(plan).toContain("not covered: expected source type tertiary-source");
  });
});
