import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { EvalResultOutcomeSchema, EvalRunReportSchema } from "./eval";

/**
 * The eval ledger's outcome contract (ADR-0007/ADR-0045): per-question
 * verdicts are persisted verbatim to `eval_results.outcome` and read back by
 * the report, so every field added here must be optional and must survive a
 * parse — an older row without it keeps reading, the new row keeps saying what
 * the gate actually measured.
 */

const PRE_CHANGE_OUTCOME = {
  questionId: "gs-v0-015",
  expectedBehavior: "answer" as const,
  passed: true,
  retrievalRecall: 1,
  citationValidity: 1,
  refused: false,
};

describe("EvalResultOutcomeSchema", () => {
  it("parses a pre-change outcome (no expansion block) — persisted rows stay readable", () => {
    const parsed = v.parse(EvalResultOutcomeSchema, PRE_CHANGE_OUTCOME);
    expect(parsed.expansion).toBeUndefined();
    expect(parsed.retrievalRecall).toBe(1);
  });

  it("carries the scope expansion's contribution when the scoped path ran (#243 C1)", () => {
    const parsed = v.parse(EvalResultOutcomeSchema, {
      ...PRE_CHANGE_OUTCOME,
      expansion: { chunks: 7, fusedOnlyRetrievalRecall: 0 },
    });
    // The metric is untouched; the provenance sits beside it, so a report can
    // say "the expansion carried this pass" without re-reading the trace.
    expect(parsed.expansion).toEqual({ chunks: 7, fusedOnlyRetrievalRecall: 0 });
  });

  it("rejects an expansion block with an impossible count or recall", () => {
    expect(
      v.safeParse(EvalResultOutcomeSchema, {
        ...PRE_CHANGE_OUTCOME,
        expansion: { chunks: -1, fusedOnlyRetrievalRecall: 0 },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(EvalResultOutcomeSchema, {
        ...PRE_CHANGE_OUTCOME,
        expansion: { chunks: 1, fusedOnlyRetrievalRecall: 1.5 },
      }).success,
    ).toBe(false);
  });

  it("round-trips the block through the persisted report payload", () => {
    const report = {
      runId: "r1",
      setId: "golden-set-v0",
      startedAt: 1,
      finishedAt: 2,
      questions: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      meanRetrievalRecall: 1,
      meanCitationValidity: 1,
      costMicroUsd: 0,
      budgetExceeded: false,
      results: [{ ...PRE_CHANGE_OUTCOME, expansion: { chunks: 7, fusedOnlyRetrievalRecall: 0 } }],
      costs: [],
    };
    const parsed = v.parse(EvalRunReportSchema, report);
    expect(parsed.results[0]?.expansion?.fusedOnlyRetrievalRecall).toBe(0);
  });
});
