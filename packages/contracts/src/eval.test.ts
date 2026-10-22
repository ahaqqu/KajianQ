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

  it("parses a pre-metric outcome without the quote-fidelity field", () => {
    const parsed = v.parse(EvalResultOutcomeSchema, PRE_CHANGE_OUTCOME);
    expect(parsed.quoteFidelity).toBeUndefined();
  });

  it("parses and preserves a quote-fidelity measurement", () => {
    const parsed = v.parse(EvalResultOutcomeSchema, { ...CURRENT_OUTCOME, quoteFidelity: 0.5 });
    expect(parsed.quoteFidelity).toBe(0.5);
  });

  it("rejects a quote fidelity outside 0..1", () => {
    expect(
      v.safeParse(EvalResultOutcomeSchema, { ...CURRENT_OUTCOME, quoteFidelity: 1.5 }).success,
    ).toBe(false);
    expect(
      v.safeParse(EvalResultOutcomeSchema, { ...CURRENT_OUTCOME, quoteFidelity: -0.1 }).success,
    ).toBe(false);
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

  it("carries the label lookup's contribution on a label-only question (B1)", () => {
    const lookup = {
      returned: 1,
      missing: 0,
      dropped: 0,
      truncated: false,
      carriedSourceTypes: ["source-b"],
    };
    const parsed = v.parse(EvalResultOutcomeSchema, {
      ...PRE_CHANGE_OUTCOME,
      expansion: { chunks: 0, fusedOnlySourceTypeRecall: 0, lookup },
    });
    // The reported recall is untouched; the lookup's own figures sit beside it, so
    // "the lookup carried this pass" is a persisted fact rather than a trace read.
    expect(parsed.expansion?.fusedOnlySourceTypeRecall).toBe(0);
    expect(parsed.expansion?.lookup).toEqual(lookup);
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
    expect(
      v.safeParse(EvalResultOutcomeSchema, {
        ...PRE_CHANGE_OUTCOME,
        expansion: {
          chunks: 0,
          fusedOnlySourceTypeRecall: 0,
          lookup: {
            returned: -1,
            missing: 0,
            dropped: 0,
            truncated: false,
            carriedSourceTypes: [],
          },
        },
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

  it("round-trips a present quote-fidelity mean and its measured count", () => {
    const parsed = v.parse(EvalRunReportSchema, {
      runId: "r1",
      setId: "golden-set-v0",
      startedAt: 1,
      finishedAt: 2,
      questions: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      meanSourceTypeRecall: 1,
      meanCitationValidity: 1,
      meanQuoteFidelity: 0.5,
      quoteFidelityMeasured: 2,
      costMicroUsd: 0,
      budgetExceeded: false,
      results: [{ ...CURRENT_OUTCOME, quoteFidelity: 0.5 }],
      costs: [],
    });
    expect(parsed.meanQuoteFidelity).toBe(0.5);
    expect(parsed.quoteFidelityMeasured).toBe(2);
    expect(parsed.results[0]?.quoteFidelity).toBe(0.5);
  });

  it("reads a report whose quote-fidelity mean is null and carries no count", () => {
    const parsed = v.parse(EvalRunReportSchema, {
      runId: "r1",
      setId: "golden-set-v0",
      startedAt: 1,
      finishedAt: 2,
      questions: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      meanSourceTypeRecall: 1,
      meanCitationValidity: 1,
      meanQuoteFidelity: null,
      costMicroUsd: 0,
      budgetExceeded: false,
      results: [CURRENT_OUTCOME],
      costs: [],
    });
    // `null` is a measured "nothing to average", distinct from a pre-metric report
    // where both fields are absent.
    expect(parsed.meanQuoteFidelity).toBeNull();
    expect(parsed.quoteFidelityMeasured).toBeUndefined();
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
