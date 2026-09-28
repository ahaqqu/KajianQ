import { describe, expect, it, vi } from "vitest";
import { printSummary, skipLines } from "../../packages/eval/scripts/eval-cli.mjs";

/**
 * The run summary's skip line is acceptance criterion #2 of #290: the CI log
 * for a run holding a transport skip must show the question and its cause
 * without querying the store, because the gate reddens on the skip and the
 * operator reads the log, not `eval_results`, to find out why.
 *
 * This is the only automated pin on that line. The CLI glue is `.mjs`, outside
 * the typechecked and coverage corpus (`vitest.config.ts` includes
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

describe("printSummary (#290)", () => {
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

  function printedSummary(result) {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printSummary("eval:smoke", { runId: "run-1", questionCount: 2, result, costMicroUsd: 25 });
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
});
