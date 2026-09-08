import { describe, expect, it } from "vitest";
import { Budget, BudgetExceededError, budgetCapFromEnv } from "./budget";
import {
  citationValidity,
  detectRefusal,
  refusalCorrectness,
  retrievalRecall,
} from "./scorers";
import { scoreQuestion } from "./harness";
import type { GoldenQuestion } from "@app/contracts";
import type { TraceEventLike } from "./harness-types";

const question: GoldenQuestion = {
  id: "gs-test-1",
  question: "test question",
  language: "id",
  expectedSourceTypes: ["quran", "hadith"],
  requiredCitations: ["QS. 2:255"],
  expectedBehavior: "answer",
};

describe("retrievalRecall", () => {
  it("scores 1 when every expected source type was retrieved", () => {
    const recall = retrievalRecall(
      ["quran", "hadith"],
      [{ id: "c1" }, { id: "c2" }],
      (id) => (id === "c1" ? "quran" : "hadith"),
    );
    expect(recall).toBe(1);
  });

  it("scores partially when only some expected types were retrieved", () => {
    const recall = retrievalRecall(["quran", "hadith"], [{ id: "c1" }], () => "quran");
    expect(recall).toBe(0.5);
  });

  it("scores 0 when nothing expected was retrieved", () => {
    const recall = retrievalRecall(["quran"], [{ id: "c1" }], () => "kitab");
    expect(recall).toBe(0);
  });

  it("scores 1 for a question with no expected sources", () => {
    const recall = retrievalRecall([], [], () => undefined);
    expect(recall).toBe(1);
  });
});

describe("citationValidity", () => {
  it("scores 1 when all required citations appear in the answer", () => {
    expect(citationValidity(["QS. 2:255", "HR. Bukhari no. 1"], "… QS. 2:255 … HR. Bukhari no. 1 …")).toBe(1);
  });

  it("scores partially when a citation is missing", () => {
    expect(citationValidity(["QS. 2:255", "HR. Bukhari no. 1"], "QS. 2:255 only")).toBe(0.5);
  });

  it("scores 1 when no citations are required", () => {
    expect(citationValidity([], "anything")).toBe(1);
  });
});

describe("refusalCorrectness", () => {
  it("passes when a refusal case refuses", () => {
    expect(refusalCorrectness("refuse", true)).toBe(true);
  });
  it("fails when a refusal case answers", () => {
    expect(refusalCorrectness("refuse", false)).toBe(false);
  });
  it("passes when an answer case answers", () => {
    expect(refusalCorrectness("answer", false)).toBe(true);
  });
});

describe("detectRefusal", () => {
  it("detects a trace refusal event", () => {
    expect(detectRefusal([{ kind: "refusal" }], "", [])).toBe(true);
  });
  it("detects a refusal marker in the text", () => {
    expect(detectRefusal([], "tidak menemukan dalil yang memadai", ["tidak menemukan dalil yang memadai"])).toBe(true);
  });
  it("is false for a plain answer", () => {
    expect(detectRefusal([{ kind: "retrieval" }], "a confident answer", ["no match"])).toBe(false);
  });
});

describe("scoreQuestion", () => {
  const retrievalEvent: TraceEventLike = {
    kind: "retrieval",
    stage: "retriever",
    detail: { chunks: [{ id: "c1" }, { id: "c2" }] },
  };

  it("passes a fully correct answer", () => {
    const outcome = scoreQuestion(question, "… QS. 2:255 …", [retrievalEvent], {
      sourceTypeOf: (id) => (id === "c1" ? "quran" : "hadith"),
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.retrievalRecall).toBe(1);
    expect(outcome.citationValidity).toBe(1);
  });

  it("fails when the required citation is missing", () => {
    const outcome = scoreQuestion(question, "no citation here", [retrievalEvent], {
      sourceTypeOf: () => "quran",
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.citationValidity).toBe(0);
  });

  it("scores recall 0 when no retrieval event exists in the trace", () => {
    const outcome = scoreQuestion(question, "QS. 2:255", [], {
      sourceTypeOf: () => undefined,
    });
    expect(outcome.retrievalRecall).toBe(0);
    expect(outcome.passed).toBe(false);
  });

  it("passes a correct refusal via trace event", () => {
    const refuseCase: GoldenQuestion = {
      ...question,
      expectedBehavior: "refuse",
      requiredCitations: [],
      expectedSourceTypes: [],
    };
    const outcome = scoreQuestion(refuseCase, "cannot answer", [{ kind: "refusal" }], {
      sourceTypeOf: () => undefined,
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.refused).toBe(true);
  });
});

describe("Budget", () => {
  it("accumulates spend and reports the total", () => {
    const budget = new Budget(100);
    expect(budget.add(30)).toBe(30);
    expect(budget.add(30)).toBe(60);
    expect(budget.total).toBe(60);
  });

  it("throws when the cap is exceeded", () => {
    const budget = new Budget(100);
    budget.add(90);
    expect(() => budget.check(20)).toThrow(BudgetExceededError);
  });

  it("is unlimited without a cap", () => {
    const budget = new Budget(undefined);
    budget.add(10_000_000);
    expect(() => budget.check()).not.toThrow();
  });

  it("treats a zero cap as unlimited (explicit opt-out)", () => {
    const budget = new Budget(0);
    expect(() => budget.check(999_999_999)).not.toThrow();
  });
});

describe("budgetCapFromEnv", () => {
  it("parses an integer cap", () => {
    expect(budgetCapFromEnv("5000")).toBe(5000);
  });
  it("is undefined when unset or empty", () => {
    expect(budgetCapFromEnv(undefined)).toBeUndefined();
    expect(budgetCapFromEnv("")).toBeUndefined();
  });
  it("rejects non-integer or negative caps", () => {
    expect(() => budgetCapFromEnv("1.5")).toThrow();
    expect(() => budgetCapFromEnv("-1")).toThrow();
  });
});