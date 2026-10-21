import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";
import { EvalResultOutcomeSchema, EvalRunReportSchema } from "./eval";

/**
 * The eval ledger's outcome contract (ADR-0007/ADR-0045): per-question
 * verdicts are persisted verbatim to `eval_results.outcome` and read back by
 * the report, so every field added here must be optional and must survive a
 * parse — an older row without it keeps reading, the new row keeps saying what
 * the gate actually measured.
 */

/** A row written before this contract version: the metrics' earlier names, no address metric. */
const PRE_CHANGE_OUTCOME = {
  questionId: "gs-v0-015",
  expectedBehavior: "answer" as const,
  passed: true,
  retrievalRecall: 1,
  citationValidity: 1,
  refused: false,
};

/** A row written under the current contract. */
const CURRENT_OUTCOME = {
  questionId: "gs-v0-015",
  expectedBehavior: "answer" as const,
  passed: true,
  sourceTypeRecall: 1,
  citationAddressRecall: 1,
  citationValidity: 1,
  refused: false,
};

describe("EvalResultOutcomeSchema", () => {
  it("parses a pre-change outcome (legacy metric names) — persisted rows stay readable", () => {
    const parsed = v.parse(EvalResultOutcomeSchema, PRE_CHANGE_OUTCOME);
    expect(parsed.expansion).toBeUndefined();
    // The legacy name is read into the current one; the row predates the address
    // measurement, so it carries no invented value for that dimension.
    expect(parsed.sourceTypeRecall).toBe(1);
    expect(parsed.citationAddressRecall).toBeUndefined();
  });

  it("parses the current outcome with both recall dimensions", () => {
    const parsed = v.parse(EvalResultOutcomeSchema, CURRENT_OUTCOME);
    expect(parsed.sourceTypeRecall).toBe(1);
    expect(parsed.citationAddressRecall).toBe(1);
  });

  it("rejects a row carrying neither the current nor the legacy source-type name", () => {
    const { sourceTypeRecall: _current, ...withoutRecall } = CURRENT_OUTCOME;
    expect(v.safeParse(EvalResultOutcomeSchema, withoutRecall).success).toBe(false);
  });

  it("carries the scope expansion's contribution when the scoped path ran (#243 C1)", () => {
    const parsed = v.parse(EvalResultOutcomeSchema, {
      ...CURRENT_OUTCOME,
      expansion: { chunks: 7, fusedOnlySourceTypeRecall: 0 },
    });
    // The metric is untouched; the provenance sits beside it, so a report can
    // say "the expansion carried this pass" without re-reading the trace.
    expect(parsed.expansion).toEqual({ chunks: 7, fusedOnlySourceTypeRecall: 0 });
  });

  it("reads an expansion block written under the pre-rename field name", () => {
    const parsed = v.parse(EvalResultOutcomeSchema, {
      ...PRE_CHANGE_OUTCOME,
      expansion: { chunks: 7, fusedOnlyRetrievalRecall: 0 },
    });
    expect(parsed.expansion).toEqual({ chunks: 7, fusedOnlySourceTypeRecall: 0 });
  });

  it("rejects an expansion block with an impossible count or recall", () => {
    expect(
      v.safeParse(EvalResultOutcomeSchema, {
        ...CURRENT_OUTCOME,
        expansion: { chunks: -1, fusedOnlySourceTypeRecall: 0 },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(EvalResultOutcomeSchema, {
        ...CURRENT_OUTCOME,
        expansion: { chunks: 1, fusedOnlySourceTypeRecall: 1.5 },
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
      meanSourceTypeRecall: 1,
      meanCitationAddressRecall: 1,
      meanCitationValidity: 1,
      costMicroUsd: 0,
      budgetExceeded: false,
      results: [{ ...CURRENT_OUTCOME, expansion: { chunks: 7, fusedOnlySourceTypeRecall: 0 } }],
      costs: [],
    };
    const parsed = v.parse(EvalRunReportSchema, report);
    expect(parsed.results[0]?.expansion?.fusedOnlySourceTypeRecall).toBe(0);
    expect(parsed.meanSourceTypeRecall).toBe(1);
    expect(parsed.meanCitationAddressRecall).toBe(1);
  });

  it("reads a pre-change report, whose metric names and columns predate this contract", () => {
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
      results: [PRE_CHANGE_OUTCOME],
      costs: [],
    };
    const parsed = v.parse(EvalRunReportSchema, report);
    expect(parsed.meanSourceTypeRecall).toBe(1);
    expect(parsed.meanCitationAddressRecall).toBeUndefined();
    expect(parsed.results[0]?.citationAddressRecall).toBeUndefined();
  });
});
