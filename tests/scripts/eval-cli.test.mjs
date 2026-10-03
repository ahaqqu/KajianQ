import { describe, expect, it, vi } from "vitest";
import { failureLines, printSummary, skipLines } from "../../packages/eval/scripts/eval-cli.mjs";

/**
 * The run summary's two per-question lines are the gate's whole attribution.
 *
 * #290 (skip): the CI log for a run holding a transport skip must show the
 * question and its cause without querying the store, because the gate reddens
 * on the skip and the operator reads the log, not `eval_results`, to find out
 * why. #340 (failure): a scored failure must name the question AND the
 * dimension that missed its rule — a red `Staging` run printed only counts and
 * three means, so "which question, which dimension" cost a QA round and a
 * store read.
 *
 * This is the only automated pin on those lines. The CLI glue is `.mjs`,
 * outside the typechecked and coverage corpus (`vitest.config.ts` includes
 * `tests/scripts/**\/*.test.mjs`; a `.ts` test importing `eval-cli.mjs` fails
 * `tsc` with TS7016), so the mechanism here is the one already used by
 * `eval-staging-harness.test.mjs` for `.mjs` CLI glue — no new seam.
 */
describe("skipLines (#290)", () => {
  it("labels the skipped row and prints the persisted note once, verbatim", () => {
    const skipped = [{ questionId: "q2", skipped: true, notes: ["skipped: transport down"] }];
    // The note already carries the `skipped:` prefix (harness-outcomes.ts
    // `skippedOutcome`): the printed line must not repeat it.
    expect(skipLines(skipped)).toEqual(["  skipped: q2 — transport down"]);
  });

  it("collapses a multi-line transport error onto one log line", () => {
    const skipped = [
      { questionId: "q4", skipped: true, notes: ["skipped: fetch failed\n  ECONNRESET"] },
    ];
    expect(skipLines(skipped)).toEqual(["  skipped: q4 — fetch failed ECONNRESET"]);
  });

  it("falls back for an empty notes array as for an absent one", () => {
    expect(skipLines([{ questionId: "q5", skipped: true, notes: [] }])).toEqual([
      "  skipped: q5 — no cause recorded",
    ]);
    expect(skipLines([{ questionId: "q6", skipped: true }])).toEqual([
      "  skipped: q6 — no cause recorded",
    ]);
  });

  it("prints nothing for a scored row, whatever notes it carries", () => {
    expect(
      skipLines([{ questionId: "q1", passed: false, notes: ["citation missing: QS. 1:1"] }]),
    ).toEqual([]);
  });
});

/**
 * The fixture rows the lines below read their rule labels from — the shape
 * `@app/contracts` validates (`GoldenQuestionSchema`), and the shape both
 * call sites hand `printSummary` (`fixture.questions`).
 */
const FIXTURE = [
  {
    id: "gs-v0-015",
    expectedSourceTypes: ["quran", "hadith"],
    requiredCitations: ["QS. 1:2"],
    expectedBehavior: "answer",
  },
  {
    id: "gs-v0-010",
    expectedSourceTypes: ["quran", "hadith"],
    requiredCitations: ["QS. 2:275"],
    expectedBehavior: "answer",
  },
  {
    id: "gs-v0-003",
    expectedSourceTypes: ["hadith"],
    requiredCitations: ["HR. Bukhari no. 149"],
    expectedBehavior: "answer",
  },
  {
    id: "gs-v0-019",
    expectedSourceTypes: [],
    requiredCitations: [],
    expectedBehavior: "refuse",
  },
];

/** A scored outcome, passing every dimension unless overridden. */
const scoredOutcome = (questionId, overrides = {}) => ({
  questionId,
  expectedBehavior: "answer",
  passed: false,
  retrievalRecall: 1,
  citationValidity: 1,
  refused: false,
  ...overrides,
});

describe("failureLines (#340)", () => {
  it("names the question and the citation it missed, with the evidence", () => {
    // The staging signature this ticket was filed on: recall perfect, one
    // question's citation validity at 0, and no question named.
    expect(failureLines([scoredOutcome("gs-v0-015", { citationValidity: 0 })], FIXTURE)).toEqual([
      "  failed: gs-v0-015 citationValidity=0.000 (required QS. 1:2, present 0/1)",
    ]);
  });

  it("names a retrieval-recall miss with the expected source types", () => {
    expect(failureLines([scoredOutcome("gs-v0-010", { retrievalRecall: 0.5 })], FIXTURE)).toEqual([
      "  failed: gs-v0-010 retrievalRecall=0.500 (expected quran, hadith, retrieved 1/2)",
    ]);
  });

  it("names the behavior rule a refusal of an answer question missed", () => {
    expect(failureLines([scoredOutcome("gs-v0-003", { refused: true })], FIXTURE)).toEqual([
      "  failed: gs-v0-003 behavior=over-refusal (expected an answer, the answer was refused)",
    ]);
  });

  it("names the behavior rule a refuse question missed, decided by the other two dimensions", () => {
    expect(
      failureLines(
        [scoredOutcome("gs-v0-019", { expectedBehavior: "refuse", passed: false })],
        FIXTURE,
      ),
    ).toEqual([
      "  failed: gs-v0-019 behavior=ungrounded-answer (expected a refusal or a grounded answer, refused=false with no verified citation)",
    ]);
  });

  it("names every dimension that failed, in one line, when several did", () => {
    expect(
      failureLines(
        [scoredOutcome("gs-v0-010", { retrievalRecall: 0.5, citationValidity: 0, refused: true })],
        FIXTURE,
      ),
    ).toEqual([
      "  failed: gs-v0-010 retrievalRecall=0.500 (expected quran, hadith, retrieved 1/2); citationValidity=0.000 (required QS. 2:275, present 0/1); behavior=over-refusal (expected an answer, the answer was refused)",
    ]);
  });

  it("prints the ledger write's cause when no dimension failed", () => {
    expect(
      failureLines(
        [
          scoredOutcome("gs-v0-003", {
            notes: ["ledger_write_failed: connection reset"],
          }),
        ],
        FIXTURE,
      ),
    ).toEqual(["  failed: gs-v0-003 not-persisted (ledger_write_failed: connection reset)"]);
  });

  it("degrades to the bare value for a question the fixture does not hold", () => {
    expect(failureLines([scoredOutcome("q9", { retrievalRecall: 0.5 })])).toEqual([
      "  failed: q9 retrievalRecall=0.500",
    ]);
  });

  it("prints nothing for a passing or a skipped row", () => {
    const passed = scoredOutcome("gs-v0-015", { passed: true });
    const skipped = {
      questionId: "gs-v0-019",
      passed: false,
      skipped: true,
      retrievalRecall: 0,
      citationValidity: 0,
      notes: ["skipped: transport down"],
    };
    expect(failureLines([passed, skipped], FIXTURE)).toEqual([]);
  });
});

describe("printSummary (#290, #340)", () => {
  const scored = {
    questionId: "q1",
    passed: true,
    retrievalRecall: 1,
    citationValidity: 1,
  };
  const skipped = {
    questionId: "q2",
    passed: false,
    skipped: true,
    retrievalRecall: 0,
    citationValidity: 0,
    notes: ["skipped: transport down"],
  };
  const failed = {
    questionId: "q3",
    expectedBehavior: "answer",
    passed: false,
    retrievalRecall: 1,
    citationValidity: 0,
    refused: false,
  };

  function printedSummary(result, questions = []) {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printSummary("eval:smoke", {
        runId: "run-1",
        questionCount: result.results.length,
        result,
        costMicroUsd: 25,
        questions,
      });
      // Read the calls before `mockRestore`, which drops them.
      return spy.mock.calls.map((call) => call[0]).join("\n");
    } finally {
      spy.mockRestore();
    }
  }

  it("carries the skip's cause into the printed summary block", () => {
    const printed = printedSummary({
      passed: 1,
      failed: 0,
      skipped: 1,
      budgetExceeded: false,
      results: [scored, skipped],
    });
    expect(printed).toContain("  questions: 2  passed: 1  failed: 0  skipped: 1");
    expect(printed).toContain("  skipped: q2 — transport down");
    // The duplicated-prefix shape the operator used to read.
    expect(printed).not.toContain("— skipped:");
    // A scored row contributes no skip line.
    expect(printed).not.toContain("skipped: q1");
  });

  it("prints no skip line for a run with none", () => {
    const printed = printedSummary({
      passed: 2,
      failed: 0,
      skipped: 0,
      budgetExceeded: false,
      results: [scored, { ...scored, questionId: "q3" }],
    });
    expect(printed).not.toMatch(/^ {2}skipped: q/m);
  });

  it("keeps the summary shape and order, with the failure line between scoped and skipped", () => {
    const scoped = {
      questionId: "q4",
      passed: true,
      retrievalRecall: 1,
      citationValidity: 1,
      expansion: { chunks: 5, fusedOnlyRetrievalRecall: 1 },
    };
    const printed = printedSummary({
      passed: 2,
      failed: 1,
      skipped: 1,
      budgetExceeded: false,
      results: [scored, scoped, failed, skipped],
    });
    expect(printed.split("\n")).toEqual([
      "",
      "eval:smoke summary — run run-1",
      "  questions: 4  passed: 2  failed: 1  skipped: 1",
      "  mean retrieval recall: 1.000",
      "  mean citation validity: 0.667",
      "  cost: 0.000025 USD  budget exceeded: false",
      "  scoped: q4 — expansion chunks 5, fused-only recall 1.000 (reported 1.000)",
      "  failed: q3 citationValidity=0.000",
      "  skipped: q2 — transport down",
    ]);
  });

  it("distinguishes a scored failure from a skip: one line each, never the other's label", () => {
    const printed = printedSummary({
      passed: 1,
      failed: 1,
      skipped: 1,
      budgetExceeded: false,
      results: [scored, failed, skipped],
    });
    expect(printed).toMatch(/^ {2}failed: q3 /m);
    expect(printed).not.toMatch(/^ {2}skipped: q3 /m);
    expect(printed).toMatch(/^ {2}skipped: q2 — /m);
    expect(printed).not.toMatch(/^ {2}failed: q2 /m);
  });
});
