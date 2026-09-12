import { describe, expect, it } from "vitest";
import { Budget } from "./budget";
import {
  runGoldenSet,
  type AnswerTraceSource,
  type ChatTransport,
  type RunLedger,
} from "./harness";
import type { GoldenSet } from "@app/contracts";
import type { TraceEventLike } from "./harness-types";

const set: GoldenSet = {
  id: "set-test",
  status: "v0-draft",
  questions: [
    {
      id: "q1",
      question: "one",
      language: "id",
      expectedSourceTypes: ["source-a"],
      requiredCitations: ["label-1"],
      expectedBehavior: "answer",
    },
    {
      id: "q2",
      question: "two",
      language: "id",
      expectedSourceTypes: [],
      requiredCitations: [],
      expectedBehavior: "refuse",
    },
    {
      id: "q3",
      question: "three",
      language: "id",
      expectedSourceTypes: [],
      requiredCitations: [],
      expectedBehavior: "answer",
    },
  ],
};

/** Fakes: transport answers q1 fully, refuses q2, and fails q3 (skip path). */
function makeDeps(
  opts: {
    failThird?: boolean;
    budget?: Budget;
    /** Trace events returned for every message lookup (default: costless). */
    traceEvents?: () => TraceEventLike[];
    /** Make every `saveResult` reject, to exercise the ledger-failure path. */
    failLedger?: boolean;
  } = {},
) {
  const savedResults: { questionId: string; outcome: unknown; runId: string }[] = [];
  let runLabel = "";
  let savedReport: unknown;
  const transport: ChatTransport = {
    async ask(question) {
      if (opts.failThird && question.id === "q3") {
        throw new Error("transport down");
      }
      if (question.expectedBehavior === "refuse") {
        return {
          text: "tidak menemukan dalil yang memadai",
          messageId: `m-${question.id}`,
          traceId: `t-${question.id}`,
        };
      }
      return {
        text: "the answer cites label-1",
        messageId: `m-${question.id}`,
        traceId: `t-${question.id}`,
      };
    },
  };
  const traces: AnswerTraceSource = {
    async eventsByMessage(messageId) {
      const events = opts.traceEvents
        ? opts.traceEvents()
        : [
            { kind: "retrieval", stage: "retriever", detail: { chunks: [{ id: "c1" }] } },
            { kind: "llm_call", stage: "generator", detail: { purpose: "generate" } },
          ];
      return messageId.startsWith("m-") ? events : null;
    },
  };
  const ledger: RunLedger = {
    async createRun(label) {
      runLabel = label;
      return "run-1";
    },
    async refreshRun(_runId, label, report) {
      runLabel = label;
      savedReport = report;
    },
    async saveResult(runId, questionId, outcome) {
      if (opts.failLedger) throw new Error("An error has occurred");
      savedResults.push({ questionId, outcome, runId });
      return questionId;
    },
  };
  const deps = {
    transport,
    traces,
    ledger,
    sourceTypeOf: (id: string) => (id === "c1" ? "source-a" : undefined),
    budget: opts.budget ?? new Budget(undefined),
    refusalMarkers: ["tidak menemukan dalil yang memadai"],
    label: "test-label",
  };
  return { deps, savedResults, getLabel: () => runLabel, getReport: () => savedReport };
}

describe("runGoldenSet", () => {
  it("scores every question and persists per-question results with the real run id", async () => {
    const { deps, savedResults, getLabel } = makeDeps();
    const result = await runGoldenSet(set, deps);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.runId).toBe("run-1");
    expect(getLabel()).toBe("test-label");
    expect(savedResults).toHaveLength(3);
    // A3: every row is keyed by the real run id, not a blank.
    for (const saved of savedResults) expect(saved.runId).toBe("run-1");
    // q1 passed: expected source retrieved + citation present.
    expect(savedResults[0]?.outcome).toMatchObject({
      passed: true,
      retrievalRecall: 1,
      citationValidity: 1,
    });
  });

  it("records one result per question when the ledger write fails — no phantom skip", async () => {
    const { deps, savedResults } = makeDeps({ failLedger: true });
    const result = await runGoldenSet(set, deps);
    // A ledger failure must fail the question, not duplicate it: the previous
    // shape pushed the scored result AND a "skipped" entry, so two questions
    // produced four rows and two phantom skips — enough to fail the smoke for an
    // infrastructure reason while the report disagreed with its own question
    // count. Only a transport/trace failure is a genuine skip.
    expect(result.results).toHaveLength(set.questions.length);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(set.questions.length);
    expect(savedResults).toHaveLength(0);
    for (const entry of result.results) {
      expect(entry.passed).toBe(false);
      expect(entry.notes?.some((n) => n.startsWith("ledger_write_failed:"))).toBe(true);
    }
  });

  it("persists the final report with the real run id (A4)", async () => {
    const { deps, getReport } = makeDeps();
    const result = await runGoldenSet(set, deps);
    const report = getReport() as { runId: string; costMicroUsd: number; costs: unknown[] };
    expect(report.runId).toBe(result.runId);
    expect(report.runId).toBe("run-1");
    // B1: the report carries the budget accumulator's total and the
    // per-question cost records, not hard-coded zeros.
    expect(report.costMicroUsd).toBe(0);
    expect(report.costs).toHaveLength(0);
  });

  it("collects per-question cost records from the traces (B1)", async () => {
    const cost = {
      modelId: "test-model",
      tokensIn: 10,
      tokensOut: 5,
      latencyMs: 5,
      costMicroUsd: 7,
    };
    const { deps, getReport } = makeDeps({
      traceEvents: () => [
        { kind: "retrieval", stage: "retriever", detail: { chunks: [{ id: "c1" }] } },
        { kind: "llm_call", stage: "generator", cost, detail: { purpose: "generate" } },
      ],
    });
    const result = await runGoldenSet(set, deps);
    const report = getReport() as { costMicroUsd: number; costs: { costMicroUsd: number }[] };
    // B1: the report's costs come from the traces — all three questions
    // scored (the skip path only fires on transport failure); the budget
    // total is the caller's accumulator, still 0 here.
    expect(report.costs).toHaveLength(3);
    expect(report.costs[0]?.costMicroUsd).toBe(7);
    expect(report.costMicroUsd).toBe(0);
  });

  it("marks a skipped (transport-failed) question with the explicit skipped flag (C1)", async () => {
    const { deps, savedResults } = makeDeps({ failThird: true });
    const result = await runGoldenSet(set, deps);
    expect(result.skipped).toBe(1);
    expect(savedResults).toHaveLength(2);
    const skipped = result.results.find((r) => r.questionId === "q3");
    expect(skipped?.skipped).toBe(true);
    expect(skipped?.notes?.[0]).toMatch(/^skipped: transport down/);
    // C1: a skipped result never counts as a scored failure.
    const scored = result.results.filter((r) => r.skipped !== true);
    expect(scored).toHaveLength(2);
  });

  it("aborts the remaining questions when the budget is exhausted", async () => {
    const tight = new Budget(1);
    const { deps } = makeDeps({ budget: tight });
    // Pre-spend the whole budget so the first check aborts.
    tight.add(2);
    const result = await runGoldenSet(set, deps);
    expect(result.results).toHaveLength(0);
    expect(result.budgetExceeded).toBe(true);
  });
});
