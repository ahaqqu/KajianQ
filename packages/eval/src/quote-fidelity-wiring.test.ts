import { describe, expect, it } from "vite-plus/test";
import type { EvalResultOutcome, GoldenQuestion, GoldenSet } from "@app/contracts";
import { buildReport, scoreQuestion } from "./harness";
import type { CitationFrameLike, TraceEventLike } from "./harness-types";

const QUESTION: GoldenQuestion = {
  id: "gs-v0-test",
  question: "Bagaimana tata cara wudhu?",
  language: "id",
  expectedSourceTypes: ["primary"],
  requiredCitations: ["HR. Bukhari no. 191"],
  expectedBehavior: "answer",
};

const EVENTS: readonly TraceEventLike[] = [
  {
    kind: "retrieval",
    stage: "fused",
    detail: { chunks: [{ id: "chunk-1" }] },
  },
];

const DEPS = {
  sourceTypeOf: () => "primary",
  citationOf: () => "HR. Bukhari no. 191",
  refusalMarkers: [] as readonly string[],
};

const FRAME = {
  citations: [
    {
      label: "HR. Bukhari no. 191",
      arabic: "كان يغسل يديه",
      translation:
        "Ia menuangkan air ke telapak tangannya lalu mencucinya, atau berkumur-kumur, lalu memasukkan air ke hidung dari satu cedukan telapak tangannya.",
    },
  ],
} satisfies CitationFrameLike;

describe("scoreQuestion — quote fidelity", () => {
  it("scores a faithful quotation as 1", () => {
    const outcome = scoreQuestion(
      QUESTION,
      'Wudhu dimulai dengan "berkumur-kumur, lalu memasukkan air ke hidung" (HR. Bukhari no. 191).',
      EVENTS,
      DEPS,
      FRAME,
    );
    expect(outcome.quoteFidelity).toBe(1);
  });

  it("scores a paraphrase inside quotation marks below 1 without changing passed", () => {
    const outcome = scoreQuestion(
      QUESTION,
      'Wudhu dimulai dengan "berkumur-kumur dan beristinsyaq" (HR. Bukhari no. 191).',
      EVENTS,
      DEPS,
      FRAME,
    );
    expect(outcome.quoteFidelity).toBe(0);
    // Report-only: the metric never decides the verdict.
    expect(outcome.passed).toBe(true);
  });

  it("scores one verified span of two as the fraction 0.5 and notes the miss", () => {
    const outcome = scoreQuestion(
      QUESTION,
      'Wudhu: "berkumur-kumur, lalu memasukkan air ke hidung" dan "berkumur-kumur dan beristinsyaq" (HR. Bukhari no. 191).',
      EVENTS,
      DEPS,
      FRAME,
    );
    expect(outcome.quoteFidelity).toBe(0.5);
    expect(outcome.notes).toEqual(["quote_unverified: 1 of 2 spans"]);
  });

  it("applies the caller-supplied quote equivalences", () => {
    const outcome = scoreQuestion(
      QUESTION,
      'Wudhu: "menuangkan air ke telapaktangannya" (HR. Bukhari no. 191).',
      EVENTS,
      { ...DEPS, quoteEquivalences: [{ pattern: /\btelapak\s+/gu, replacement: "telapak" }] },
      FRAME,
    );
    expect(outcome.quoteFidelity).toBe(1);
  });

  it("omits the metric when the answer quotes nothing", () => {
    const outcome = scoreQuestion(
      QUESTION,
      "Wudhu dimulai dengan mencuci telapak tangan (HR. Bukhari no. 191).",
      EVENTS,
      DEPS,
      FRAME,
    );
    expect(outcome.quoteFidelity).toBeUndefined();
  });

  it("omits the metric when the frame carries no cited text", () => {
    const outcome = scoreQuestion(
      QUESTION,
      'Wudhu: "berkumur-kumur, lalu memasukkan air ke hidung" (HR. Bukhari no. 191).',
      EVENTS,
      DEPS,
      { citations: [{ label: "HR. Bukhari no. 191" }] } satisfies CitationFrameLike,
    );
    expect(outcome.quoteFidelity).toBeUndefined();
  });

  it("omits the metric when every quoted span is shorter than the threshold", () => {
    const outcome = scoreQuestion(
      QUESTION,
      'Kata "لا إله" saja (HR. Bukhari no. 191).',
      EVENTS,
      DEPS,
      FRAME,
    );
    expect(outcome.quoteFidelity).toBeUndefined();
  });
});

describe("buildReport — mean quote fidelity", () => {
  const SET: GoldenSet = { id: "set", status: "v0-draft", questions: [QUESTION] };
  const outcome = (id: string, quoteFidelity?: number): EvalResultOutcome => ({
    questionId: id,
    expectedBehavior: "answer" as const,
    passed: true,
    sourceTypeRecall: 1,
    citationValidity: 1,
    refused: false,
    ...(quoteFidelity === undefined ? {} : { quoteFidelity }),
  });

  const build = (results: EvalResultOutcome[]) =>
    buildReport(SET, {
      runId: "run",
      startedAt: 0,
      finishedAt: 1,
      results,
      passed: results.length,
      failed: 0,
      skipped: 0,
      budgetExceeded: false,
      scored: results,
      costMicroUsd: 0,
      costs: [],
    });

  it("averages only the answers that quoted something and states the denominator", () => {
    const report = build([outcome("a", 1), outcome("b", 0), outcome("c")]);
    expect(report.meanQuoteFidelity).toBe(0.5);
    expect(report.quoteFidelityMeasured).toBe(2);
  });

  it("reports a null mean and no denominator when no answer was measured", () => {
    const report = build([outcome("a"), outcome("b")]);
    expect(report.meanQuoteFidelity).toBeNull();
    expect(report.quoteFidelityMeasured).toBeUndefined();
  });
});
