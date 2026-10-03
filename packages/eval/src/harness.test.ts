import { describe, expect, it } from "vitest";
import { Budget } from "./budget";
import {
  runGoldenSet,
  type AnswerTraceSource,
  type ChatTransport,
  type HarnessDeps,
  type RunLedger,
} from "./harness";
import { ledgerFailureNote } from "./harness-outcomes";
import type { EvalResultOutcome, GoldenSet } from "@app/contracts";
import { StoreError } from "@app/rag-core";
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
    /**
     * What `saveResult` rejects with (default `new Error("An error has
     * occurred")`). A real ledger rejects with the seam's `StoreError` (A2).
     */
    ledgerError?: unknown;
    /** The opaque origin label injected as the harness's expansion marker. */
    expansionOrigin?: string;
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
      if (opts.failLedger) throw opts.ledgerError ?? new Error("An error has occurred");
      savedResults.push({ questionId, outcome, runId });
      return questionId;
    },
  };
  const deps = {
    transport,
    traces,
    ledger,
    sourceTypeOf: (id: string) => (id === "c1" || id === "x1" ? "source-a" : undefined),
    budget: opts.budget ?? new Budget(undefined),
    refusalMarkers: ["tidak menemukan dalil yang memadai"],
    label: "test-label",
    ...(opts.expansionOrigin !== undefined ? { expansionOrigin: opts.expansionOrigin } : {}),
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

  it("keeps the run and its report alive when the skip row's own write fails (A1)", async () => {
    // The skip path's ledger guard (harness.ts, the `catch (ledgerErr)` around
    // the skip's `saveResult`) is what keeps a failed row from taking the run
    // down. Falsification: rethrowing there rejects `runGoldenSet` on the first
    // skip — `refreshRun` never runs (no `eval_runs` report row) and every
    // remaining question goes unmeasured. Both flags together are what pins it.
    const { deps, getReport } = makeDeps({ failThird: true, failLedger: true });
    const result = await runGoldenSet(set, deps);
    expect(result.skipped).toBe(1);
    expect(result.results).toHaveLength(set.questions.length);
    const skip = result.results.find((r) => r.questionId === "q3");
    expect(skip?.notes).toEqual([
      "skipped: transport down",
      "ledger_write_failed: An error has occurred",
    ]);
    // The report survived the failed write: refreshRun still ran, carrying the
    // skip and BOTH notes (the store could not record either one).
    const report = getReport() as {
      skipped: number;
      results: { questionId: string; skipped?: boolean; notes?: string[] }[];
    };
    expect(report).not.toBeNull();
    expect(report.skipped).toBe(1);
    expect(report.results.find((r) => r.questionId === "q3")).toMatchObject({
      skipped: true,
      notes: ["skipped: transport down", "ledger_write_failed: An error has occurred"],
    });
  });

  it("keeps the store's copy of a skip free of the report's ledger-failure note (B3)", async () => {
    // An ambiguous write: the store kept the object it was handed AND the
    // caller saw a rejection (the INSERT committed, the response was lost).
    // The report's extra note must not reach back into that stored object —
    // the Postgres adapter stringifies at call time, but a store that holds
    // the reference would otherwise observe an annotation it never received.
    const observed: EvalResultOutcome[] = [];
    const { deps } = makeDeps({ failThird: true });
    const ambiguous = {
      ...deps,
      ledger: {
        ...deps.ledger,
        async saveResult(_runId: string, questionId: string, outcome: EvalResultOutcome) {
          observed.push(outcome);
          if (questionId === "q3") throw new Error("connection reset after commit");
          return questionId;
        },
      },
    };
    const result = await runGoldenSet(set, ambiguous);
    expect(observed.find((o) => o.questionId === "q3")?.notes).toEqual(["skipped: transport down"]);
    expect(result.results.find((r) => r.questionId === "q3")?.notes).toEqual([
      "skipped: transport down",
      "ledger_write_failed: connection reset after commit",
    ]);
  });

  it("names a real StoreError's kind and cause, not its empty message (A2)", () => {
    // `StoreError` — what the ledger seam's `saveResult` actually rejects with
    // — is an `Error` whose `message` is `""` (store-error.ts:43), so the shape
    // this note used to read printed `ledger_write_failed: ` and nothing else.
    // Each of the five kinds carries its meaning in `kind` + the wrapped
    // `cause`; these pins go red the moment the note loses either one.
    expect(
      ledgerFailureNote(
        new StoreError({ kind: "transport", cause: new Error("connection reset") }),
      ),
    ).toBe("ledger_write_failed: transport: connection reset");
    expect(
      ledgerFailureNote(
        new StoreError({ kind: "constraint", cause: new RangeError("invalid vector dimension") }),
      ),
    ).toBe("ledger_write_failed: constraint: invalid vector dimension");
    expect(
      ledgerFailureNote(
        new StoreError({
          kind: "timeout",
          cause: new Error("statement timeout", { cause: "57014" }),
        }),
      ),
    ).toBe("ledger_write_failed: timeout: statement timeout");
    // A cause the adapter could not wrap: still named, never blank.
    expect(ledgerFailureNote(new StoreError({ kind: "config", cause: undefined }))).toBe(
      "ledger_write_failed: config: no cause",
    );
    expect(ledgerFailureNote(new StoreError({ kind: "not_found", cause: { code: "23505" } }))).toBe(
      'ledger_write_failed: not_found: {"code":"23505"}',
    );
  });

  it("falls back for a throwable that is not a StoreError (A2)", () => {
    expect(ledgerFailureNote(new Error("connection reset"))).toBe(
      "ledger_write_failed: connection reset",
    );
    // An empty-message non-StoreError Error keeps its name; nothing prints blank.
    expect(ledgerFailureNote(new Error(""))).toBe("ledger_write_failed: Error");
    expect(ledgerFailureNote("boom")).toBe("ledger_write_failed: boom");
    expect(ledgerFailureNote(undefined)).toBe("ledger_write_failed: no cause");
  });

  it("names a real StoreError on both ledger-write failure paths (A2)", async () => {
    // The two call sites share `ledgerFailureNote`: the scored write
    // (harness.ts:167) and the skip's own row (harness.ts:189). Before this,
    // both printed a bare `ledger_write_failed:` for the one error the real
    // ledger raises.
    const scored = makeDeps({
      failLedger: true,
      ledgerError: new StoreError({ kind: "transport", cause: new Error("connection reset") }),
    });
    const scoredRun = await runGoldenSet(set, scored.deps);
    expect(scoredRun.results.map((r) => r.notes)).toEqual([
      ["ledger_write_failed: transport: connection reset"],
      ["ledger_write_failed: transport: connection reset"],
      ["ledger_write_failed: transport: connection reset"],
    ]);

    const skipped = makeDeps({
      failThird: true,
      failLedger: true,
      ledgerError: new StoreError({ kind: "constraint", cause: new Error("duplicate key value") }),
    });
    const skippedRun = await runGoldenSet(set, skipped.deps);
    expect(skippedRun.results.find((r) => r.questionId === "q3")?.notes).toEqual([
      "skipped: transport down",
      "ledger_write_failed: constraint: duplicate key value",
    ]);
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
    // One row per question, the skipped one included (#290 persists it).
    expect(savedResults).toHaveLength(3);
    const skipped = result.results.find((r) => r.questionId === "q3");
    expect(skipped?.skipped).toBe(true);
    expect(skipped?.notes?.[0]).toMatch(/^skipped: transport down/);
    // C1: a skipped result never counts as a scored failure.
    const scored = result.results.filter((r) => r.skipped !== true);
    expect(scored).toHaveLength(2);
  });

  it("persists the transport skip's cause to the ledger and carries it into the report (#290)", async () => {
    const { deps, savedResults, getReport } = makeDeps({ failThird: true });
    const result = await runGoldenSet(set, deps);
    expect(result.skipped).toBe(1);
    // The skip is an outcome like every other one: its own `eval_results` row,
    // keyed by the real run id, naming the question and the error message.
    expect(savedResults).toHaveLength(set.questions.length);
    const row = savedResults.find((entry) => entry.questionId === "q3");
    expect(row?.runId).toBe("run-1");
    expect(row?.outcome).toMatchObject({
      questionId: "q3",
      skipped: true,
      refused: false,
      passed: false,
      retrievalRecall: 0,
      citationValidity: 0,
      notes: ["skipped: transport down"],
    });
    // The run report carries the same note, so the store and the report cannot
    // disagree about why the gate reddened.
    const report = getReport() as {
      results: { questionId: string; skipped?: boolean; notes?: string[] }[];
    };
    const reported = report.results.find((r) => r.questionId === "q3");
    expect(reported?.skipped).toBe(true);
    const persisted = row?.outcome as EvalResultOutcome | undefined;
    expect(reported?.notes).toEqual(persisted?.notes);
  });

  it("keeps a transport skip distinct from a refusal and a scorer failure in the persisted evidence (#290)", async () => {
    // Three ways to land on `passed: false` with citation validity 0. The
    // distinguishing field is `skipped` (never a notes-prefix heuristic):
    // #274's ungrounded-citation refusal is a SCORED outcome with
    // `refused: true`, an ordinary scorer failure is a SCORED outcome with
    // neither flag, and only a transport failure is a skip. The test pins all
    // three so the modes cannot silently collapse into one shape.
    const refusal = "tidak menemukan dalil yang memadai";
    const trio: GoldenSet = {
      id: "set-trio",
      status: "v0-draft",
      questions: ["refused", "unscored", "skipped"].map((id) => ({
        id,
        question: `question ${id}`,
        language: "id",
        expectedSourceTypes: ["source-a"],
        requiredCitations: ["label-1"],
        expectedBehavior: "answer" as const,
      })),
    };
    const saved: { questionId: string; outcome: EvalResultOutcome }[] = [];
    const deps: HarnessDeps = {
      transport: {
        async ask(question) {
          if (question.id === "skipped") throw new Error("fetch failed: ECONNRESET");
          return {
            text: question.id === "refused" ? refusal : "an answer with no citation",
            messageId: `m-${question.id}`,
            traceId: `t-${question.id}`,
          };
        },
      },
      traces: {
        async eventsByMessage() {
          return [{ kind: "retrieval", stage: "retriever", detail: { chunks: [{ id: "c1" }] } }];
        },
      },
      ledger: {
        async createRun() {
          return "run-trio";
        },
        async refreshRun() {},
        async saveResult(_runId, questionId, outcome) {
          saved.push({ questionId, outcome });
          return questionId;
        },
      },
      sourceTypeOf: (id) => (id === "c1" ? "source-a" : undefined),
      budget: new Budget(undefined),
      refusalMarkers: [refusal],
    };
    await runGoldenSet(trio, deps);
    const byId = new Map(saved.map((entry) => [entry.questionId, entry.outcome]));
    expect(byId.get("skipped")).toMatchObject({
      passed: false,
      refused: false,
      retrievalRecall: 0,
      citationValidity: 0,
      skipped: true,
      notes: ["skipped: fetch failed: ECONNRESET"],
    });
    // #274: a scored refusal of an `answer` question — no `skipped` field.
    expect(byId.get("refused")).toMatchObject({
      passed: false,
      refused: true,
      citationValidity: 0,
    });
    expect(byId.get("refused")).not.toHaveProperty("skipped");
    // An ordinary scorer failure: scored, unrefused, nothing skipped.
    expect(byId.get("unscored")).toMatchObject({
      passed: false,
      refused: false,
      retrievalRecall: 1,
      citationValidity: 0,
    });
    expect(byId.get("unscored")).not.toHaveProperty("skipped");
  });

  it("persists the expansion's contribution on each scoped outcome (C1)", async () => {
    const { deps, savedResults } = makeDeps({
      expansionOrigin: "expansion",
      traceEvents: () => [
        {
          kind: "retrieval",
          stage: "retriever",
          detail: {
            chunks: [
              { id: "f0", score: 0.5, rankDense: 1 },
              { id: "x1", origin: "expansion" },
            ],
          },
        },
        {
          kind: "scope_expansion",
          stage: "retriever",
          detail: { key: "reference", value: "1", returned: 1, cap: 12, truncated: false },
        },
      ],
    });
    await runGoldenSet(set, deps);
    // q1 expects source-a, which ONLY the expansion ref supplies (the fused
    // ref f0 resolves to no source type): the reported recall is 1 while the
    // fused track alone scores 0 — the persisted statement "the expansion
    // carried this question", visible in the report beside the metric.
    expect(savedResults[0]?.outcome).toMatchObject({
      retrievalRecall: 1,
      expansion: { chunks: 1, fusedOnlyRetrievalRecall: 0 },
    });
  });

  it("omits the expansion block when the caller injected no origin label (C1)", async () => {
    // The engine never names a caller's label: with none supplied it cannot
    // say which refs the expansion added, so it says nothing rather than
    // guessing from a score-less ref.
    const { deps, savedResults } = makeDeps({
      traceEvents: () => [
        {
          kind: "retrieval",
          stage: "retriever",
          detail: { chunks: [{ id: "c1" }, { id: "x1", origin: "expansion" }] },
        },
        {
          kind: "scope_expansion",
          stage: "retriever",
          detail: { key: "reference", value: "1", returned: 1, cap: 12, truncated: false },
        },
      ],
    });
    await runGoldenSet(set, deps);
    expect(Object.hasOwn(savedResults[0]?.outcome as object, "expansion")).toBe(false);
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
