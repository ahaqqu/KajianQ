import { describe, expect, it, vi } from "vitest";
import {
  exitPolicy,
  exitWithPolicy,
  failureLines,
  printSummary,
  skipLines,
} from "../../packages/eval/scripts/eval-cli.mjs";
// The producer side of the ledger-failure note, imported by path so the note
// these lines render is the one the harness really writes (round-2 A2). A
// hand-written note string is exactly the false pin that round found: it can
// spell a cause the producer cannot emit, and passes forever.
import { ledgerFailureNote } from "../../packages/eval/src/harness-outcomes.ts";
import { StoreError } from "../../packages/rag-core/src/store-error.ts";

/**
 * The run summary's two per-question lines are the gate's whole attribution.
 *
 * #290 (skip): the CI log for a run holding a transport skip must show the
 * question and its cause without querying the store, because the gate reddens
 * on the skip and the operator reads the log, not `eval_results`, to find out
 * why. #340 (failure): a scored failure must name the question AND the
 * dimension that missed its rule — a red `Staging` run printed only counts and
 * three means, so "which question, which dimension" cost a QA round and a
 * store read. #364 (exit policy): what turns those lines into a gate — before
 * it, `eval:run` printed them and exited 0, so the release gate's green was an
 * operator's read. The summary rows and the policy rows are the same subject
 * from two sides: the policy says red, these lines say why.
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

  it("prints the ledger write's real cause — a StoreError's kind and cause (A2)", () => {
    // The note comes from the producer itself, not a hand-written string. A
    // `StoreError` carries no `message` at all, so the round-2 shape rendered
    // `ledger_write_failed: ` here and this line lost its cause.
    const note = ledgerFailureNote(
      new StoreError({ kind: "transport", cause: new Error("connection reset") }),
    );
    expect(failureLines([scoredOutcome("gs-v0-003", { notes: [note] })], FIXTURE)).toEqual([
      "  failed: gs-v0-003 not-persisted (ledger_write_failed: transport: connection reset)",
    ]);
  });

  it("degrades to the bare value only for a fixture that genuinely lacks the question (B4)", () => {
    // The `[]` is deliberate and says so: no fixture is in hand, so no rule
    // label exists to print. An *omitted* fixture is a different thing and
    // fails loudly (see the guard case below) instead of degrading every line.
    expect(failureLines([scoredOutcome("q9", { retrievalRecall: 0.5 })], [])).toEqual([
      "  failed: q9 retrievalRecall=0.500",
    ]);
  });

  it("refuses a missing fixture rather than degrading every failure line (B4)", () => {
    expect(() => failureLines([scoredOutcome("gs-v0-015", { citationValidity: 0 })])).toThrow(
      /requires the fixture's questions/,
    );
    // Not a fixture either: `fixture.questions` is the argument, never the
    // fixture itself.
    expect(() =>
      failureLines([scoredOutcome("gs-v0-015", { citationValidity: 0 })], FIXTURE[0]),
    ).toThrow(/requires the fixture's questions/);
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

  // `questions` has no default (B4): every caller hands the fixture it holds,
  // exactly as `eval-smoke.mjs` and `eval-run.mjs` do with `fixture.questions`.
  function printedSummary(result, questions) {
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
    const printed = printedSummary(
      {
        passed: 1,
        failed: 0,
        skipped: 1,
        budgetExceeded: false,
        results: [scored, skipped],
      },
      FIXTURE,
    );
    expect(printed).toContain("  questions: 2  passed: 1  failed: 0  skipped: 1");
    expect(printed).toContain("  skipped: q2 — transport down");
    // The duplicated-prefix shape the operator used to read.
    expect(printed).not.toContain("— skipped:");
    // A scored row contributes no skip line.
    expect(printed).not.toContain("skipped: q1");
  });

  it("leaves a passing run's summary unchanged (#340 acceptance: counts, means, expansion lines)", () => {
    const scoped = {
      questionId: "q3",
      passed: true,
      retrievalRecall: 1,
      citationValidity: 1,
      expansion: { chunks: 5, fusedOnlyRetrievalRecall: 1 },
    };
    const printed = printedSummary(
      {
        passed: 2,
        failed: 0,
        skipped: 0,
        budgetExceeded: false,
        results: [scored, scoped],
      },
      FIXTURE,
    );
    expect(printed.split("\n")).toEqual([
      "",
      "eval:smoke summary — run run-1",
      "  questions: 2  passed: 2  failed: 0  skipped: 0",
      "  mean retrieval recall: 1.000",
      "  mean citation validity: 1.000",
      "  cost: 0.000025 USD  budget exceeded: false",
      "  scoped: q3 — expansion chunks 5, fused-only recall 1.000 (reported 1.000)",
    ]);
    expect(printed).not.toMatch(/^ {2}(failed|skipped): /m);
  });

  it("keeps the summary shape and order, with the failure line between scoped and skipped", () => {
    const scoped = {
      questionId: "q4",
      passed: true,
      retrievalRecall: 1,
      citationValidity: 1,
      expansion: { chunks: 5, fusedOnlyRetrievalRecall: 1 },
    };
    const printed = printedSummary(
      {
        passed: 2,
        failed: 1,
        skipped: 1,
        budgetExceeded: false,
        results: [scored, scoped, failed, skipped],
      },
      FIXTURE,
    );
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
    const printed = printedSummary(
      {
        passed: 1,
        failed: 1,
        skipped: 1,
        budgetExceeded: false,
        results: [scored, failed, skipped],
      },
      FIXTURE,
    );
    expect(printed).toMatch(/^ {2}failed: q3 /m);
    expect(printed).not.toMatch(/^ {2}skipped: q3 /m);
    expect(printed).toMatch(/^ {2}skipped: q2 — /m);
    expect(printed).not.toMatch(/^ {2}failed: q2 /m);
  });

  it("refuses to print a summary with no fixture in hand (B4)", () => {
    const result = {
      passed: 0,
      failed: 1,
      skipped: 0,
      budgetExceeded: false,
      results: [failed],
    };
    expect(() =>
      printSummary("eval:smoke", { runId: "run-1", questionCount: 1, result, costMicroUsd: 25 }),
    ).toThrow(/requires the fixture's questions/);
  });
});

/**
 * The exit policy the two commands share (#364).
 *
 * Before this ticket `eval:run` ended at `printSummary`: a run whose questions
 * failed, were skipped, or were never asked at all exited 0, so the documented
 * release gate was green until an operator chose to read the block above. Each
 * row below names the mutation that must redden it, because the risk this file
 * guards is a one-clause deletion: the function is a handful of lines, and
 * losing any clause reopens the silent green.
 *
 * The expected strings are hand-written on purpose, against the file's usual
 * preference for the producer. `eval-smoke.mjs` cannot supply them — importing
 * it runs the CLI — and after this ticket the only producer is `exitPolicy`
 * itself, so importing the string would make the assertion circular. These
 * literals are the CI-observable contract (`gh run view`, the `Staging` log);
 * changing one is a deliberate contract change, which is exactly what a pin is
 * for.
 *
 * The last two rows drive `exitWithPolicy`, the effectful half: the verdict
 * rows above pin `ok: false`, and only these pin that `ok: false` ends the
 * process (#370 A1). A pin that stops at the return value leaves the gate's
 * blocking half free to be deleted with the suite green.
 */
describe("exitPolicy (#364)", () => {
  const passed = scoredOutcome("gs-v0-015", { passed: true });
  const failedQuestion = scoredOutcome("gs-v0-010", { citationValidity: 0 });
  const skippedQuestion = {
    questionId: "gs-v0-003",
    skipped: true,
    notes: ["skipped: transport down"],
  };

  it("reddens on a failed question, for both command prefixes", () => {
    // Mutation: dropping the `failed` clause — the pre-#364 `eval:run`, which
    // ended at printSummary and exited 0 on exactly this run.
    const input = {
      runId: "run-7",
      questionCount: 1,
      result: {
        passed: 0,
        failed: 1,
        skipped: 0,
        budgetExceeded: false,
        results: [failedQuestion],
      },
    };
    expect(exitPolicy("eval:run", input)).toEqual({
      ok: false,
      message: "eval:run: FAILED — 1 failed, 0 skipped. See eval_results for run run-7.",
    });
    // The smoke's own pre-#364 line, byte for byte: the shared policy must not
    // have reworded the string `Staging` operators and logs already read.
    expect(exitPolicy("eval:smoke", input).message).toBe(
      "eval:smoke: FAILED — 1 failed, 0 skipped. See eval_results for run run-7.",
    );
  });

  it("reddens on a skipped question — an unmeasured question is not a pass (#290)", () => {
    // Mutation: dropping the `skipped` clause. The smoke has reddened on a
    // skip since #290; this clause is what makes `eval:run` agree with it.
    const input = {
      runId: "run-7",
      questionCount: 1,
      result: {
        passed: 0,
        failed: 0,
        skipped: 1,
        budgetExceeded: false,
        results: [skippedQuestion],
      },
    };
    expect(exitPolicy("eval:smoke", input)).toEqual({
      ok: false,
      message: "eval:smoke: FAILED — 0 failed, 1 skipped. See eval_results for run run-7.",
    });
    expect(exitPolicy("eval:run", input).message).toBe(
      "eval:run: FAILED — 0 failed, 1 skipped. See eval_results for run run-7.",
    );
  });

  it("reddens on a run that recorded fewer outcomes than it asked for (the budget abort)", () => {
    // Mutation: dropping the `unmeasured` clause. `harness.ts` breaks the
    // question loop on the cap without counting the remainder, so this run's
    // own record reads passed: 2, failed: 0, skipped: 0 — the literal
    // failed/skipped policy returns ok: true here, and a release run truncated
    // after 2 of 4 questions goes green with real money already spent.
    const input = {
      runId: "run-8",
      questionCount: 4,
      result: {
        passed: 2,
        failed: 0,
        skipped: 0,
        budgetExceeded: true,
        results: [passed, scoredOutcome("gs-v0-010", { passed: true })],
      },
    };
    expect(exitPolicy("eval:run", input)).toEqual({
      ok: false,
      message:
        "eval:run: FAILED — 0 failed, 0 skipped, 2 unmeasured (budget exceeded). See eval_results for run run-8.",
    });
    expect(exitPolicy("eval:smoke", input).message).toBe(
      "eval:smoke: FAILED — 0 failed, 0 skipped, 2 unmeasured (budget exceeded). See eval_results for run run-8.",
    );
  });

  it("passes a complete, all-passed run — the only green there is", () => {
    // Mutation: any clause widened past the three counts, e.g. reddening on
    // `result.passed === 0`, or deleting the ok early-return so every healthy
    // run — including the smoke on a good deploy — reddens.
    const input = {
      runId: "run-9",
      questionCount: 1,
      result: {
        passed: 1,
        failed: 0,
        skipped: 0,
        budgetExceeded: false,
        results: [passed],
      },
    };
    expect(exitPolicy("eval:run", input)).toEqual({ ok: true, message: "eval:run: PASSED" });
    expect(exitPolicy("eval:smoke", input)).toEqual({ ok: true, message: "eval:smoke: PASSED" });
  });

  it("measures the shortfall against the set that was asked, not the whole fixture", () => {
    // Mutation: the one copy-paste this ticket exists to prevent — handing the
    // policy `fixture.questions.length` (30) instead of the smoke's subset (5),
    // which would read every healthy smoke run as truncated and redden the
    // `Staging` gate on a good deploy. The second assertion is that mutation,
    // made visible.
    const input = {
      runId: "run-10",
      questionCount: 5,
      result: {
        passed: 5,
        failed: 0,
        skipped: 0,
        budgetExceeded: false,
        results: [passed, passed, passed, passed, passed],
      },
    };
    expect(exitPolicy("eval:smoke", input)).toEqual({ ok: true, message: "eval:smoke: PASSED" });
    expect(exitPolicy("eval:smoke", { ...input, questionCount: 30 }).message).toBe(
      "eval:smoke: FAILED — 0 failed, 0 skipped, 25 unmeasured. See eval_results for run run-10.",
    );
  });

  it("names a shortfall without claiming a cause the run's record does not carry", () => {
    // Mutation: hard-coding "(budget exceeded)" into the truncation clause.
    // `budgetExceeded` is the run's own record of why the loop stopped; a
    // shortfall it does not explain must not be attributed to the cap.
    const input = {
      runId: "run-11",
      questionCount: 3,
      result: {
        passed: 1,
        failed: 0,
        skipped: 0,
        budgetExceeded: false,
        results: [passed],
      },
    };
    expect(exitPolicy("eval:run", input)).toEqual({
      ok: false,
      message:
        "eval:run: FAILED — 0 failed, 0 skipped, 2 unmeasured. See eval_results for run run-11.",
    });
  });

  it("takes its counts from the recorded rows, not from the run's counters (#370 A2)", () => {
    // Mutation: reading `result.failed`/`result.skipped` — the two
    // representations of one fact that `printSummary` already resolves in
    // favour of the rows. Here the counters claim a clean pass while the one
    // recorded row did not pass, and a verdict that trusted the counters would
    // return ok: true: the silent green this policy exists to close, reached
    // through the disagreement the counters make possible.
    const input = {
      runId: "run-12",
      questionCount: 1,
      result: {
        passed: 1,
        failed: 0,
        skipped: 0,
        budgetExceeded: false,
        results: [failedQuestion],
      },
    };
    expect(exitPolicy("eval:run", input)).toEqual({
      ok: false,
      message: "eval:run: FAILED — 1 failed, 0 skipped. See eval_results for run run-12.",
    });
  });

  it("names the disagreement when more rows were recorded than the set asked for (#370 A2)", () => {
    // Mutation: guarding the truncation segment with `unmeasured > 0` alone.
    // A negative shortfall — unreachable through the harness, reachable through
    // this function's input — then reddens with no clause naming why, or (if
    // the shortfall were clamped) does not redden at all. Every red line must
    // name its reason, so the excess direction gets its own clause rather than
    // a negative count.
    const input = {
      runId: "run-13",
      questionCount: 1,
      result: {
        passed: 2,
        failed: 0,
        skipped: 0,
        budgetExceeded: false,
        results: [passed, passed],
      },
    };
    expect(exitPolicy("eval:run", input)).toEqual({
      ok: false,
      message:
        "eval:run: FAILED — 0 failed, 0 skipped, 1 recorded beyond the set asked. See eval_results for run run-13.",
    });
  });

  it("exits 1 on a red verdict, to stderr — the half that makes the gate blocking (#370 A1)", () => {
    // Mutation: deleting the `process.exit(1)` from `exitWithPolicy`. The
    // verdict rows above pin `ok: false`; not one of them pins that the red
    // verdict ends the process, so that deletion kept every row green while
    // both CLIs printed the red line and exited 0 — the exact silent green
    // #364 exists to close, on the release gate.
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("__exit__");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const input = {
        runId: "run-14",
        questionCount: 1,
        result: {
          passed: 0,
          failed: 1,
          skipped: 0,
          budgetExceeded: false,
          results: [failedQuestion],
        },
      };
      // The throwing stub is how a real exit is observed without ending the
      // test process: control must not continue past `process.exit`.
      expect(() => exitWithPolicy("eval:run", input)).toThrow("__exit__");
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      // The red line goes to stderr and nowhere else — the same stream the
      // smoke has always written to.
      expect(err).toHaveBeenCalledTimes(1);
      expect(err).toHaveBeenCalledWith(
        "eval:run: FAILED — 1 failed, 0 skipped. See eval_results for run run-14.",
      );
      expect(log).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      err.mockRestore();
      log.mockRestore();
    }
  });

  it("does not exit on a green verdict, to stdout (#370 A1)", () => {
    // The other half of the A1 pin: a mutation that exits unconditionally — or
    // moves the exit above the ok early-return — would redden every healthy
    // run, the smoke on a good deploy included. A gate that cannot be green is
    // not a gate.
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      exitWithPolicy("eval:run", {
        runId: "run-15",
        questionCount: 1,
        result: {
          passed: 1,
          failed: 0,
          skipped: 0,
          budgetExceeded: false,
          results: [passed],
        },
      });
      expect(exit).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("eval:run: PASSED");
    } finally {
      exit.mockRestore();
      err.mockRestore();
      log.mockRestore();
    }
  });
});
