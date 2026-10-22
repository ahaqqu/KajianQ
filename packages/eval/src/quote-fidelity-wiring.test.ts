import { describe, expect, it } from "vite-plus/test";
import type { GoldenQuestion } from "@app/contracts";
import { buildReport, scoreQuestion } from "./harness";
import type { CitationFrameLike, TraceEventLike } from "./harness-types";

const QUESTION = {
  id: "gs-v0-test",
  question: "Bagaimana tata cara wudhu?",
  expectedBehavior: "answer",
  expectedSourceTypes: ["primary"],
  requiredCitations: ["HR. Bukhari no. 191"],
} as unknown as GoldenQuestion;

const EVENTS: readonly TraceEventLike[] = [
  {
    kind: "retrieval",
    stage: "fused",
    detail: { chunks: [{ id: "chunk-1" }] },
  } as unknown as TraceEventLike,
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

  it("scores a paraphrase inside quotation marks below 1", () => {
    const outcome = scoreQuestion(
      QUESTION,
      'Wudhu dimulai dengan "berkumur-kumur dan beristinsyaq" (HR. Bukhari no. 191).',
      EVENTS,
      DEPS,
      FRAME,
    );
    expect(outcome.quoteFidelity).toBe(0);
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
});

describe("buildReport — mean quote fidelity", () => {
  const outcome = (id: string, quoteFidelity?: number) => ({
    questionId: id,
    expectedBehavior: "answer" as const,
    passed: true,
    sourceTypeRecall: 1,
    citationValidity: 1,
    refused: false,
    ...(quoteFidelity === undefined ? {} : { quoteFidelity }),
  });

  const build = (results: ReturnType<typeof outcome>[]) =>
    buildReport(
      { id: "set", questions: [], status: "draft" } as unknown as Parameters<typeof buildReport>[0],
      {
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
      },
    );

  it("averages only the answers that quoted something", () => {
    expect(build([outcome("a", 1), outcome("b", 0), outcome("c")]).meanQuoteFidelity).toBe(0.5);
  });

  it("reports null when no answer quoted anything", () => {
    expect(build([outcome("a"), outcome("b")]).meanQuoteFidelity).toBeNull();
  });
});
