import { describe, expect, it } from "vitest";
import { Budget, BudgetExceededError, budgetCapFromEnv } from "./budget";
import {
  citationLabelsPresent,
  citationValidity,
  detectRefusal,
  refusalCorrectness,
  retrievalRecall,
} from "./scorers";
import { scoreQuestion } from "./harness";
import type { GoldenQuestion } from "@app/contracts";
import type { CitationFrameLike, TraceEventLike } from "./harness-types";

const question: GoldenQuestion = {
  id: "gs-test-1",
  question: "test question",
  language: "id",
  expectedSourceTypes: ["source-a", "source-b"],
  requiredCitations: ["label-1"],
  expectedBehavior: "answer",
};

describe("retrievalRecall", () => {
  it("scores 1 when every expected source type was retrieved", () => {
    const recall = retrievalRecall(["source-a", "source-b"], [{ id: "c1" }, { id: "c2" }], (id) =>
      id === "c1" ? "source-a" : "source-b",
    );
    expect(recall).toBe(1);
  });

  it("scores partially when only some expected types were retrieved", () => {
    const recall = retrievalRecall(["source-a", "source-b"], [{ id: "c1" }], () => "source-a");
    expect(recall).toBe(0.5);
  });

  it("scores 0 when nothing expected was retrieved", () => {
    const recall = retrievalRecall(["source-a"], [{ id: "c1" }], () => "source-c");
    expect(recall).toBe(0);
  });

  it("scores 1 for a question with no expected sources", () => {
    const recall = retrievalRecall([], [], () => undefined);
    expect(recall).toBe(1);
  });
});

describe("citationValidity", () => {
  it("scores 1 when all required citations appear in the answer", () => {
    expect(citationValidity(["label-1", "label-2"], "… label-1 … label-2 …")).toBe(1);
  });

  it("scores partially when a citation is missing", () => {
    expect(citationValidity(["label-1", "label-2"], "label-1 only")).toBe(0.5);
  });

  it("scores 1 when no citations are required", () => {
    expect(citationValidity([], "anything")).toBe(1);
  });

  /**
   * The text-fallback path with the gate's grammar injected (the CLI wiring).
   * The grammar is faked here — the engine package must not depend on the
   * domain pack — and its shape mirrors the real `normalizeCitationLabel` /
   * `citationCandidatesIn` pair, canonicalizing the marker spellings the way
   * the real functions do.
   */
  const canon = (label: string): string =>
    label
      .replace(/[*_`]+/g, "")
      .replace(/\bQ\.?S\.?(?=\s)/g, "QS.")
      .replace(/\s+/g, " ")
      .trim();
  const grammar = {
    normalizeLabel: canon,
    labelsInText: (text: string) =>
      [...text.matchAll(/Q\.?S\.?\s*[^\s:,[\]()]+\s*:\s*\d+/g)].map((m) => canon(m[0]!)),
  };

  it("matches a marker-spelling variant the raw substring check misses", () => {
    // Live-staging shape: the fixture curates `QS. 1:2`, but a model (or the
    // store's label) may carry the dotted `Q.S.` or the dot-less `QS ` form.
    // `"… Q.S. 1:2 …".includes("QS. 1:2")` is false — a grounded citation
    // scored 0 on spelling alone. The grammar canonicalizes both sides.
    expect(citationValidity(["QS. 1:2"], "… Q.S. 1:2 …")).toBe(0);
    expect(citationValidity(["QS. 1:2"], "… Q.S. 1:2 …", { grammar })).toBe(1);
    expect(citationValidity(["QS. 1:2"], "… QS 1:2 …")).toBe(0);
    expect(citationValidity(["QS. 1:2"], "… QS 1:2 …", { grammar })).toBe(1);
  });

  it("ignores whitespace reflow between the marker and the address", () => {
    expect(citationValidity(["QS. 1:2"], "… QS.  1:2 …")).toBe(0);
    expect(citationValidity(["QS. 1:2"], "… QS.  1:2 …", { grammar })).toBe(1);
  });

  it("normalizes the required label too, so a marker variant matches", () => {
    // The fixture's own spelling may carry the variant; the text's standard.
    expect(citationValidity(["Q.S. 1:2"], "… QS. 1:2 …", { grammar })).toBe(1);
  });

  it("uses the citations frame when one is present, over the text", () => {
    // The frame is the server's grounded set; its labels win outright.
    const frame = { citations: [{ label: "QS. 1:2" }] };
    expect(citationValidity(["QS. 1:2"], "no citation in this text at all", { frame })).toBe(1);
  });

  it("NEVER scores a label the frame does not contain (ADR-0040 invariant)", () => {
    // A frame that grounds nothing cannot be talked into a pass by text that
    // happens to contain the label — a fabricated citation is not grounded.
    const frame = { citations: [{ label: "QS. 2:255" }] };
    expect(citationValidity(["QS. 1:2"], "the text writes QS. 1:2 plainly", { frame })).toBe(0);
  });

  it("scores a label absent from a non-empty frame as absent even when normalized", () => {
    const frame = { citations: [{ label: "QS. 2:255" }] };
    expect(citationValidity(["QS. 1:2"], "… **QS. 1:2** …", { frame, grammar })).toBe(0);
  });

  it("falls back to the trace's grounded labels when there is no frame", () => {
    const events: TraceEventLike[] = [
      {
        kind: "review",
        stage: "reviewer",
        detail: { verdict: "{}", grounded: ["QS. 1:2", "HR. Malik no. 187"] },
      },
    ];
    expect(citationValidity(["QS. 1:2"], "text without any marker", { events })).toBe(1);
  });

  it("treats an EMPTY grounded list as evidence of nothing, not as absent", () => {
    // A refusal records an empty `grounded` list; scoring must not fall through
    // to the text (which for a refusal is a refusal marker, not a citation).
    const events: TraceEventLike[] = [
      { kind: "review", stage: "reviewer", detail: { verdict: "{}", grounded: [] } },
    ];
    expect(citationValidity(["QS. 1:2"], "QS. 1:2 appears in the refusal text", { events })).toBe(
      0,
    );
  });

  it("falls back to the text when an older trace has no grounded field", () => {
    const events: TraceEventLike[] = [
      { kind: "review", stage: "reviewer", detail: { verdict: "{}" } },
    ];
    expect(citationValidity(["QS. 1:2"], "cites QS. 1:2", { events })).toBe(1);
  });

  it("prefers the frame over the trace's grounded labels", () => {
    const frame = { citations: [] as { label: string }[] };
    const events: TraceEventLike[] = [
      { kind: "review", stage: "reviewer", detail: { verdict: "{}", grounded: ["QS. 1:2"] } },
    ];
    expect(citationValidity(["QS. 1:2"], "QS. 1:2", { frame, events })).toBe(0);
  });
});

describe("citationLabelsPresent", () => {
  const frameOf = (labels: string[]): CitationFrameLike => ({
    citations: labels.map((label) => ({ label })),
  });

  it("returns the required labels the frame grounds, in the fixture's spelling", () => {
    expect(
      citationLabelsPresent({
        required: ["QS. 1:2", "HR. Malik no. 187"],
        answerText: "irrelevant",
        frame: frameOf(["QS. 1:2"]),
      }),
    ).toEqual(["QS. 1:2"]);
  });

  it("normalizes both sides of the frame comparison", () => {
    // The fixture keeps the curated `QS. 1:2`; a frame label in a marker
    // variant still grounds it once the grammar canonicalizes both.
    expect(
      citationLabelsPresent({
        required: ["QS. 1:2"],
        answerText: "",
        frame: frameOf(["Q.S.  1:2"]),
        grammar: {
          normalizeLabel: (label) => label.replace(/\s+/g, " ").replace("Q.S.", "QS."),
          labelsInText: () => [],
        },
      }),
    ).toEqual(["QS. 1:2"]);
  });

  it("keeps the byte-exact substring behavior when no grammar is injected", () => {
    expect(
      citationLabelsPresent({ required: ["QS. 1:2"], answerText: "cites **QS. 1:2**" }),
    ).toEqual(["QS. 1:2"]);
    expect(citationLabelsPresent({ required: ["QS. 1:2"], answerText: "cites Q.S. 1:2" })).toEqual(
      [],
    );
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
    expect(detectRefusal([{ kind: "refusal", stage: "generator" }], "", [])).toBe(true);
  });
  it("detects a refusal marker in the text", () => {
    expect(
      detectRefusal([], "tidak menemukan dalil yang memadai", [
        "tidak menemukan dalil yang memadai",
      ]),
    ).toBe(true);
  });
  it("is false for a plain answer", () => {
    expect(
      detectRefusal([{ kind: "retrieval", stage: "retriever" }], "a confident answer", [
        "no match",
      ]),
    ).toBe(false);
  });
});

describe("scoreQuestion", () => {
  const retrievalEvent: TraceEventLike = {
    kind: "retrieval",
    stage: "retriever",
    detail: { chunks: [{ id: "c1" }, { id: "c2" }] },
  };

  it("passes a fully correct answer", () => {
    const outcome = scoreQuestion(question, "… label-1 …", [retrievalEvent], {
      sourceTypeOf: (id) => (id === "c1" ? "source-a" : "source-b"),
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.retrievalRecall).toBe(1);
    expect(outcome.citationValidity).toBe(1);
  });

  it("fails when the required citation is missing", () => {
    const outcome = scoreQuestion(question, "no citation here", [retrievalEvent], {
      sourceTypeOf: () => "source-a",
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.citationValidity).toBe(0);
  });

  it("scores recall 0 when no retrieval event exists in the trace", () => {
    const outcome = scoreQuestion(question, "label-1", [], {
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
    const outcome = scoreQuestion(
      refuseCase,
      "cannot answer",
      [{ kind: "refusal", stage: "generator" }],
      {
        sourceTypeOf: () => undefined,
      },
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.refused).toBe(true);
  });

  it("scores citation validity from the frame the transport carried", () => {
    // The answer text has no citation marker at all, but the server's frame
    // grounds it — exactly the live shape the raw-substring check mishandled.
    const outcome = scoreQuestion(
      question,
      "a grounded answer whose marker spelling differs",
      [retrievalEvent],
      { sourceTypeOf: (id) => (id === "c1" ? "source-a" : "source-b") },
      { citations: [{ label: "label-1" }] },
    );
    expect(outcome.citationValidity).toBe(1);
    expect(outcome.passed).toBe(true);
  });

  it("still scores 0 when the frame does not ground the required citation", () => {
    const outcome = scoreQuestion(
      question,
      "label-1 in prose only",
      [retrievalEvent],
      {
        sourceTypeOf: () => "source-a",
      },
      { citations: [{ label: "some-other-label" }] },
    );
    expect(outcome.citationValidity).toBe(0);
    expect(outcome.passed).toBe(false);
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
  it("is undefined when unset (A1: an empty value now fails closed)", () => {
    expect(budgetCapFromEnv(undefined)).toBeUndefined();
  });
  it("throws fail-fast on an empty/whitespace value (thermo-review A1)", () => {
    expect(() => budgetCapFromEnv("")).toThrow(/set but empty/);
    expect(() => budgetCapFromEnv("   ")).toThrow(/set but empty/);
  });
  it("rejects non-integer or negative caps", () => {
    expect(() => budgetCapFromEnv("1.5")).toThrow();
    expect(() => budgetCapFromEnv("-1")).toThrow();
  });
});
