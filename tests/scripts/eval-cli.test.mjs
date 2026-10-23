import { describe, expect, it, vi } from "vite-plus/test";
import {
  exitPolicy,
  exitWithPolicy,
  failureLines,
  printSummary,
  skipLines,
} from "../../packages/eval/scripts/eval-cli.mjs";
// The producer side of the ledger-failure note, imported by path so the note
// these lines render is the one the harness really writes: a hand-written string
// can spell a cause the producer cannot emit and pass forever.
import { ledgerFailureNote } from "../../packages/eval/src/harness-outcomes.ts";
import { StoreError } from "../../packages/rag-core/src/store-error.ts";

/**
 * The run summary's two per-question lines and the exit policy are the gate's
 * whole attribution: a skip must show its question and cause in the CI log without
 * a store read, a scored failure must name the question and the dimension that
 * missed its rule, and the policy is what turns those lines into a gate rather
 * than a block an operator has to read. The summary rows and the policy rows are
 * the same subject from two sides: the policy says red, these lines say why.
 *
 * These `.mjs` tests are the only automated pin on those lines, outside typecheck
 * and coverage: the CLI glue is `.mjs`, so a `.ts` test importing `eval-cli.mjs`
 * fails `tsc` with TS7016 — the mechanism `eval-staging-harness.test.mjs` already
 * uses for `.mjs` CLI glue.
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
 * The fixture rows the lines below read their rule labels from: the shape
 * `@app/contracts` validates and the shape both call sites hand `printSummary`.
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
    requiredCitations: ["HR. Bukhari no. 191"],
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
  sourceTypeRecall: 1,
  citationAddressRecall: 1,
  citationValidity: 1,
  refused: false,
  ...overrides,
});

describe("failureLines (#340)", () => {
  it("names the question and the citation it missed, with the evidence", () => {
    expect(failureLines([scoredOutcome("gs-v0-015", { citationValidity: 0 })], FIXTURE)).toEqual([
      "  failed: gs-v0-015 citationValidity=0.000 (required QS. 1:2, present 0/1)",
    ]);
  });

  it("names a source-type-recall miss with the expected source types", () => {
    expect(failureLines([scoredOutcome("gs-v0-010", { sourceTypeRecall: 0.5 })], FIXTURE)).toEqual([
      "  failed: gs-v0-010 sourceTypeRecall=0.500 (expected quran, hadith, retrieved 1/2)",
    ]);
  });

  it("names an address-recall miss with the required citation it never surfaced", () => {
    expect(
      failureLines([scoredOutcome("gs-v0-003", { citationAddressRecall: 0 })], FIXTURE),
    ).toEqual([
      "  failed: gs-v0-003 citationAddressRecall=0.000 (required HR. Bukhari no. 191, retrieved 0/1)",
    ]);
  });

  it("leaves the address arm out for a scored row the metric never measured", () => {
    // The field is optional for a row persisted before the metric: `undefined` is
    // "never measured", so it must not add an address arm to the failure line.
    const legacy = {
      questionId: "gs-v0-015",
      expectedBehavior: "answer",
      passed: false,
      sourceTypeRecall: 1,
      citationValidity: 0,
      refused: false,
    };
    expect(failureLines([legacy], FIXTURE)).toEqual([
      "  failed: gs-v0-015 citationValidity=0.000 (required QS. 1:2, present 0/1)",
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
        [
          scoredOutcome("gs-v0-010", {
            sourceTypeRecall: 0.5,
            citationAddressRecall: 0,
            citationValidity: 0,
            refused: true,
          }),
        ],
        FIXTURE,
      ),
    ).toEqual([
      "  failed: gs-v0-010 sourceTypeRecall=0.500 (expected quran, hadith, retrieved 1/2); citationAddressRecall=0.000 (required QS. 2:275, retrieved 0/1); citationValidity=0.000 (required QS. 2:275, present 0/1); behavior=over-refusal (expected an answer, the answer was refused)",
    ]);
  });

  it("prints the ledger write's real cause — a StoreError's kind and cause (A2)", () => {
    // The note comes from the producer, not a literal: a `StoreError` carries no
    // `message`, so the cause must come from its `kind` and `cause`.
    const note = ledgerFailureNote(
      new StoreError({ kind: "transport", cause: new Error("connection reset") }),
    );
    expect(failureLines([scoredOutcome("gs-v0-003", { notes: [note] })], FIXTURE)).toEqual([
      "  failed: gs-v0-003 not-persisted (ledger_write_failed: transport: connection reset)",
    ]);
  });

  it("degrades to the bare value only for a fixture that genuinely lacks the question (B4)", () => {
    // The `[]` is deliberate: no fixture is in hand, so no rule label exists to
    // print. An *omitted* fixture fails loudly instead of degrading every line.
    expect(failureLines([scoredOutcome("q9", { sourceTypeRecall: 0.5 })], [])).toEqual([
      "  failed: q9 sourceTypeRecall=0.500",
    ]);
  });

  it("refuses a missing fixture rather than degrading every failure line (B4)", () => {
    expect(() => failureLines([scoredOutcome("gs-v0-015", { citationValidity: 0 })])).toThrow(
      /requires the fixture's questions/,
    );
    // Not a fixture either: `fixture.questions` is the argument, never the fixture itself.
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
      sourceTypeRecall: 0,
      citationAddressRecall: 0,
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
    sourceTypeRecall: 1,
    citationAddressRecall: 1,
    citationValidity: 1,
  };
  const skipped = {
    questionId: "q2",
    passed: false,
    skipped: true,
    sourceTypeRecall: 0,
    citationAddressRecall: 0,
    citationValidity: 0,
    notes: ["skipped: transport down"],
  };
  const failed = {
    questionId: "q3",
    expectedBehavior: "answer",
    passed: false,
    sourceTypeRecall: 1,
    citationAddressRecall: 1,
    citationValidity: 0,
    refused: false,
  };

  // `questions` has no default: every caller hands the fixture it holds, as both CLIs do.
  function printedSummary(result, questions, extra = {}) {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printSummary("eval:smoke", {
        runId: "run-1",
        questionCount: result.results.length,
        result,
        costMicroUsd: 25,
        questions,
        ...extra,
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
    expect(printed).not.toContain("— skipped:");
    expect(printed).not.toContain("skipped: q1");
  });

  it("prints the reported identity-satisfied figures beside the gate's counts", () => {
    const block = (passed, citationAddressRecall) => ({
      identitySatisfied: { citationAddressRecall, citationValidity: 1, passed },
    });
    const printed = printedSummary(
      {
        passed: 1,
        failed: 1,
        skipped: 0,
        budgetExceeded: false,
        results: [
          scoredOutcome("gs-v0-015", { ...block(true, 1), passed: true }),
          scoredOutcome("gs-v0-010", block(false, 0.5)),
        ],
      },
      FIXTURE,
    );
    // Reported on the counts line, from the same derivation the run report persists:
    // the measured count is the denominator, and the gate's means above are unmoved.
    expect(printed).toContain(
      "identity-satisfied (reported): 1 of 2 rows, mean address recall 0.750",
    );
  });

  it("leaves a passing run's summary unchanged (#340 acceptance: counts, means, expansion lines)", () => {
    const scoped = {
      questionId: "q3",
      passed: true,
      sourceTypeRecall: 1,
      citationAddressRecall: 1,
      citationValidity: 1,
      expansion: { chunks: 5, fusedOnlySourceTypeRecall: 1 },
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
      "  mean source-type recall: 1.000",
      "  mean citation-address recall: 1.000",
      "  mean citation validity: 1.000",
      "  mean quote fidelity: n/a (0 of 2 answers measured)",
      "  cost: 0.000025 USD  budget exceeded: false",
      "  deterministic: q3 — scope chunks 5; fused-only source-type recall 1.000 (reported 1.000)",
    ]);
    expect(printed).not.toMatch(/^ {2}(failed|skipped): /m);
  });

  it("derives the reported address misses from the run's own scores", () => {
    const missed = scoredOutcome("gs-v0-003", { citationAddressRecall: 0 });
    const printed = printedSummary(
      {
        passed: 1,
        failed: 1,
        skipped: 0,
        budgetExceeded: false,
        results: [scored, missed],
      },
      FIXTURE,
      { reportAddressMisses: true },
    );
    expect(printed).toContain(
      "  address recall: reported, not gated — address misses in this sample (1 of 2 measured): gs-v0-003; the sample decides this line, not a full-set debt list",
    );
    // The address mean still prints above it: the dimension is reported in full.
    expect(printed).toContain("  mean citation-address recall: 0.500");
  });

  it("pins the reporting caller's whole block, line for line", () => {
    // The block, not only the derived line: what a `reportAddressMisses: true`
    // caller prints is exactly these rows, so a second line — a hand-written list
    // rendered beside the derived one, whatever its source or name — fails here.
    // A list threaded through a *different option* cannot fail this test (the test
    // never passes it), which is why the smoke's call site pins its whole input
    // set in `eval-staging-harness.test.mjs`.
    const missed = scoredOutcome("gs-v0-003", { citationAddressRecall: 0 });
    const printed = printedSummary(
      {
        passed: 1,
        failed: 1,
        skipped: 0,
        budgetExceeded: false,
        results: [scored, missed],
      },
      FIXTURE,
      { reportAddressMisses: true },
    );
    expect(printed.split("\n")).toEqual([
      "",
      "eval:smoke summary — run run-1",
      "  questions: 2  passed: 1  failed: 1  skipped: 0",
      "  mean source-type recall: 1.000",
      "  mean citation-address recall: 0.500",
      "  address recall: reported, not gated — address misses in this sample (1 of 2 measured): gs-v0-003; the sample decides this line, not a full-set debt list",
      "  mean citation validity: 1.000",
      "  mean quote fidelity: n/a (0 of 2 answers measured)",
      "  cost: 0.000025 USD  budget exceeded: false",
      "  failed: gs-v0-003 citationAddressRecall=0.000 (required HR. Bukhari no. 191, retrieved 0/1)",
    ]);
  });

  it("says the sample produced no address miss instead of naming a stale list", () => {
    const printed = printedSummary(
      { passed: 1, failed: 0, skipped: 0, budgetExceeded: false, results: [scored] },
      FIXTURE,
      { reportAddressMisses: true },
    );
    expect(printed).toContain(
      "  address recall: reported, not gated — address misses in this sample (0 of 1 measured): none; the sample decides this line, not a full-set debt list",
    );
  });

  it("counts only scored rows in the sample's address-debt line", () => {
    const printed = printedSummary(
      {
        passed: 1,
        failed: 0,
        skipped: 1,
        budgetExceeded: false,
        results: [scored, skipped],
      },
      FIXTURE,
      { reportAddressMisses: true },
    );
    // A skipped row's zeroed address dimension is a skip, not an address miss; the
    // line's denominator is the measured sample, so it cannot inflate the debt.
    const addressLine = printed
      .split("\n")
      .find((line) => line.includes("address misses in this sample"));
    expect(addressLine).toBe(
      "  address recall: reported, not gated — address misses in this sample (0 of 1 measured): none; the sample decides this line, not a full-set debt list",
    );
  });

  it("never prints a wider denominator than the address mean above it", () => {
    // A row persisted before the metric carries no `citationAddressRecall`: it is
    // scored, so it reaches this function, but it was never measured. The
    // denominator must be the measured set, not every scored row, or the line
    // would read "1 of 3" under a mean computed over two.
    const unmeasuredLegacy = {
      questionId: "gs-v0-015",
      passed: true,
      expectedBehavior: "answer",
      sourceTypeRecall: 1,
      citationValidity: 1,
      refused: false,
    };
    const missed = scoredOutcome("gs-v0-003", { citationAddressRecall: 0 });
    const printed = printedSummary(
      {
        passed: 2,
        failed: 1,
        skipped: 0,
        budgetExceeded: false,
        results: [scored, unmeasuredLegacy, missed],
      },
      FIXTURE,
      { reportAddressMisses: true },
    );
    const lines = printed.split("\n");
    expect(lines).toContain("  mean citation-address recall: 0.500");
    expect(lines).toContain(
      "  address recall: reported, not gated — address misses in this sample (1 of 2 measured): gs-v0-003; the sample decides this line, not a full-set debt list",
    );
  });

  it("prints no address-debt line for a caller that gates on the dimension", () => {
    expect(
      printedSummary(
        { passed: 1, failed: 0, skipped: 0, budgetExceeded: false, results: [scored] },
        FIXTURE,
      ),
    ).not.toContain("address recall: reported, not gated");
  });

  it("names the label lookup when it carried a label-only question (B1)", () => {
    // The #277 shape: no scope path ran, the fused arm alone scored nothing, and
    // the lookup supplied the only expected source. The summary must say so.
    const labelOnly = {
      questionId: "q5",
      passed: true,
      sourceTypeRecall: 1,
      citationAddressRecall: 1,
      citationValidity: 1,
      expansion: {
        chunks: 0,
        fusedOnlySourceTypeRecall: 0,
        lookup: {
          returned: 1,
          missing: 0,
          dropped: 0,
          truncated: false,
          carriedSourceTypes: ["hadith"],
        },
      },
    };
    const printed = printedSummary(
      {
        passed: 2,
        failed: 0,
        skipped: 0,
        budgetExceeded: false,
        results: [scored, labelOnly],
      },
      FIXTURE,
    );
    expect(printed).toContain(
      "  deterministic: q5 — lookup returned 1, missing 0, dropped 0 (carried hadith); fused-only source-type recall 0.000 (reported 1.000)",
    );
  });

  it("keeps the summary shape and order, with the failure line between the deterministic and skipped lines", () => {
    const scoped = {
      questionId: "q4",
      passed: true,
      sourceTypeRecall: 1,
      citationAddressRecall: 1,
      citationValidity: 1,
      expansion: { chunks: 5, fusedOnlySourceTypeRecall: 1 },
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
      "  mean source-type recall: 1.000",
      "  mean citation-address recall: 1.000",
      "  mean citation validity: 0.667",
      "  mean quote fidelity: n/a (0 of 3 answers measured)",
      "  cost: 0.000025 USD  budget exceeded: false",
      "  deterministic: q4 — scope chunks 5; fused-only source-type recall 1.000 (reported 1.000)",
      "  failed: q3 citationValidity=0.000",
      "  skipped: q2 — transport down",
    ]);
  });

  it("averages quote fidelity over the answers that quoted, not over all of them", () => {
    const faithful = { ...scored, questionId: "q1", quoteFidelity: 1 };
    const paraphrased = { ...scored, questionId: "q2", quoteFidelity: 0 };
    const silent = { ...scored, questionId: "q4" };
    const printed = printedSummary(
      {
        passed: 3,
        failed: 0,
        skipped: 0,
        budgetExceeded: false,
        results: [faithful, paraphrased, silent],
      },
      FIXTURE,
    );
    expect(printed).toContain("  mean quote fidelity: 0.500 (2 of 3 answers measured)");
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
 * The exit policy the two commands share.
 *
 * Each row below names the mutation that must redden it, because the risk this
 * file guards is a one-clause deletion: the function is a handful of lines, and
 * losing any clause reopens the silent green.
 *
 * The expected strings are hand-written on purpose: `eval-smoke.mjs` cannot
 * supply them (importing it runs the CLI) and `exitPolicy` is its own only
 * producer, so importing the string would make the assertion circular. These
 * literals are the CI-observable contract.
 *
 * The rows that drive `exitWithPolicy` pin the blocking half: the verdict rows
 * above pin `ok: false`, and only these pin that a red verdict ends the process —
 * without them the gate's blocking half could be deleted with the suite green.
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
    // Mutation: dropping the `failed` clause.
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
    // The smoke's own line, byte for byte: the shared policy must not have reworded
    // the string `Staging` operators and logs already read.
    expect(exitPolicy("eval:smoke", input).message).toBe(
      "eval:smoke: FAILED — 1 failed, 0 skipped. See eval_results for run run-7.",
    );
  });

  it("reddens on a skipped question — an unmeasured question is not a pass (#290)", () => {
    // Mutation: dropping the `skipped` clause — what makes `eval:run` agree with the smoke.
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
    // Mutation: dropping the `unmeasured` clause — the harness breaks the loop on the
    // cap without counting the remainder, so a truncated run would otherwise go green.
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
    // Mutation: any clause widened past the three reddening cases, or deleting the
    // ok early-return, which would redden every healthy run.
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
    // Mutation: handing the policy the whole fixture's count instead of the smoke's
    // subset, which would read every healthy smoke run as truncated.
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
    // Mutation: hard-coding "(budget exceeded)" into the truncation clause — the cap
    // is named only from the run's own record, never invented for a shortfall.
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
    // Mutation: reading `result.failed`/`result.skipped` — here the counters claim a
    // clean pass while the one recorded row did not, so a verdict that trusted the
    // counters would return ok: true.
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
    // Mutation: guarding the truncation segment with `unmeasured > 0` alone — a
    // negative shortfall would then redden with no clause naming why. Every red line
    // must name its reason, so the excess gets its own clause.
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
    // Mutation: deleting the `process.exit(1)` — the verdict rows above pin
    // `ok: false`, but only this pins that a red verdict ends the process.
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
      // The throwing stub observes a real exit without ending the test process.
      expect(() => exitWithPolicy("eval:run", input)).toThrow("__exit__");
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      // The red line goes to stderr and nowhere else.
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
    // A mutation that exits unconditionally, or moves the exit above the ok
    // early-return, would redden every healthy run — including a good deploy.
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
