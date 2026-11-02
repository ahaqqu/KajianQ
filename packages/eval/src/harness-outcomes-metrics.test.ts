import { describe, expect, it } from "vite-plus/test";
import type { EvalResultOutcome, GoldenQuestion, GoldenSet } from "@app/contracts";
import { answerCitationLabels, answerMetricsSummary, answerStats } from "./harness-outcomes";
import { Budget } from "./budget";
import {
  buildReport,
  runGoldenSet,
  scoreQuestion,
  type AnswerTraceSource,
  type ChatTransport,
  type RunLedger,
} from "./harness";
import type { CitationFrameLike, CitationGrammar, TraceEventLike } from "./harness-types";

/**
 * The descriptive answer-size and citation-count metrics. The trust property is that
 * every figure comes from the SAME answer the scorer already read — never a second
 * source — and that "measured zero" stays distinguishable from "never measured":
 * an empty answer is a real 0; a skipped question, a pre-metric row, and a
 * grammar-less answer with no evidence source are not.
 */

const GRAMMAR: CitationGrammar = {
  // Deliberately not identity: dedupe must run on the normalized form, and the
  // frame's spellings differ only by surrounding space and case.
  normalizeLabel: (label) => label.trim().toUpperCase().replace(/\s+/g, " "),
  labelsInText: (text) => text.match(/L-\d+/g) ?? [],
  addressesNamedBy: (label) => [label],
};

const frame = (...labels: string[]): CitationFrameLike => ({
  citations: labels.map((label) => ({ label })),
});

const review = (grounded: string[]): TraceEventLike => ({
  kind: "review",
  stage: "reviewer",
  detail: { grounded },
});

describe("answerCitationLabels — the gate's own evidence precedence", () => {
  it("reads the citations frame and deduplicates under the grammar's normalization", () => {
    expect(
      answerCitationLabels({
        answerText: "the answer cites L-1 and never says L-2",
        frame: frame("L-1", " l-1 ", "L-2"),
        grammar: GRAMMAR,
      }),
    ).toEqual(["L-1", "L-2"]);
  });

  it("treats an empty frame as authoritative, never falling back to the text", () => {
    expect(
      answerCitationLabels({
        answerText: "the answer still cites L-1 in its prose",
        frame: frame(),
        grammar: GRAMMAR,
      }),
    ).toEqual([]);
  });

  it("falls back to the trace's grounded list when no frame arrived", () => {
    expect(
      answerCitationLabels({
        answerText: "unused",
        frame: null,
        events: [review(["L-1", "L-1", "L-2"])],
        grammar: GRAMMAR,
      }),
    ).toEqual(["L-1", "L-2"]);
  });

  it("falls back to the grammar's spans in the answer text when there is no non-text evidence", () => {
    expect(
      answerCitationLabels({
        answerText: "see L-1 and L-3 and L-1 again",
        events: [{ kind: "retrieval", stage: "retriever" }],
        grammar: GRAMMAR,
      }),
    ).toEqual(["L-1", "L-3"]);
  });

  it("returns no label list when the text cannot be split without a grammar", () => {
    // The whole text is the validity fallback's only candidate; it is not a citation
    // count, so the count is UNMEASURED (absent) rather than a fabricated 0.
    expect(answerCitationLabels({ answerText: "see L-1", events: [] })).toBeUndefined();
  });
});

describe("answerStats — size and count from one answer", () => {
  it("counts Unicode code points, so an astral character counts once", () => {
    expect(answerStats({ answerText: "a😀", frame: frame(), grammar: GRAMMAR })).toEqual({
      answerChars: 2,
      citationCount: 0,
    });
  });

  it("keeps an empty answer as a measured zero", () => {
    expect(answerStats({ answerText: "", frame: frame(), grammar: GRAMMAR })).toEqual({
      answerChars: 0,
      citationCount: 0,
    });
  });

  it("counts a range label once even though it names several addresses", () => {
    expect(
      answerStats({
        answerText: "the answer cites L-1-3 as a range",
        frame: frame("L-1-3"),
        grammar: GRAMMAR,
      }).citationCount,
    ).toBe(1);
  });

  it("omits the count — never records a zero — when no source could count citations", () => {
    const stats = answerStats({ answerText: "the answer cites label-1", events: [] });
    expect(stats.answerChars).toBe(24);
    expect(stats).not.toHaveProperty("citationCount");
  });
});

/**
 * The harness supports running without a citation grammar (the field is optional on
 * `HarnessDeps`). Without one, and with no frame or trace grounded list, the answer
 * text cannot be split into citations — a count of 0 there would be a fabricated
 * measurement printed beside a citationValidity of 1 that same text earned.
 */
describe("scoreQuestion — a grammar-less answer's citation count is unmeasured", () => {
  const question: GoldenQuestion = {
    id: "q1",
    question: "ask q1",
    language: "en",
    expectedSourceTypes: [],
    requiredCitations: ["label-1"],
    expectedBehavior: "answer",
  };
  const deps = {
    sourceTypeOf: (_chunkId: string) => undefined,
    citationOf: (_chunkId: string) => undefined,
    refusalMarkers: [] as readonly string[],
  };

  it("drops the count instead of fabricating a zero beside a validity of 1", () => {
    const outcome = scoreQuestion(question, "the answer cites label-1", [], deps);
    expect(outcome.citationValidity).toBe(1);
    expect(outcome.answerChars).toBe(24);
    expect(outcome).not.toHaveProperty("citationCount");
    expect(Object.keys(outcome)).not.toContain("citationCount");
  });

  it("leaves the unmeasured row out of the aggregate instead of averaging a zero", () => {
    const outcome = scoreQuestion(question, "the answer cites label-1", [], deps);
    expect(answerMetricsSummary([outcome])).toEqual({
      meanAnswerChars: null,
      maxAnswerChars: null,
      meanCitationsPerAnswer: null,
      maxCitationsPerAnswer: null,
    });
  });

  it("still records a real zero when an empty frame is the authoritative evidence", () => {
    const outcome = scoreQuestion(question, "the answer cites label-1", [], deps, frame());
    expect(outcome).toHaveProperty("citationCount", 0);
    expect(outcome.answerChars).toBe(24);
  });

  it("counts the grammar's spans when the run injects one", () => {
    const outcome = scoreQuestion(question, "the answer cites L-1 and L-2", [], {
      ...deps,
      citationGrammar: GRAMMAR,
    });
    expect(outcome.citationCount).toBe(2);
  });
});

describe("answerMetricsSummary — aggregate over measured rows", () => {
  const row = (id: string, answerChars?: number, citationCount?: number): EvalResultOutcome => ({
    questionId: id,
    expectedBehavior: "answer",
    passed: true,
    sourceTypeRecall: 1,
    citationValidity: 1,
    refused: false,
    ...(answerChars !== undefined ? { answerChars } : {}),
    ...(citationCount !== undefined ? { citationCount } : {}),
  });

  it("returns four nulls when no answer was measured (zero-answer case)", () => {
    expect(answerMetricsSummary([])).toEqual({
      meanAnswerChars: null,
      maxAnswerChars: null,
      meanCitationsPerAnswer: null,
      maxCitationsPerAnswer: null,
    });
  });

  it("collapses mean and maximum on a single answer, including a measured zero", () => {
    expect(answerMetricsSummary([row("q1", 0, 0)])).toEqual({
      meanAnswerChars: 0,
      maxAnswerChars: 0,
      meanCitationsPerAnswer: 0,
      maxCitationsPerAnswer: 0,
    });
  });

  it("averages and maximizes over several answers", () => {
    expect(answerMetricsSummary([row("q1", 10, 1), row("q2", 20, 2), row("q3", 15, 6)])).toEqual({
      meanAnswerChars: 15,
      maxAnswerChars: 20,
      meanCitationsPerAnswer: 3,
      maxCitationsPerAnswer: 6,
    });
  });

  it("excludes a pre-metric row instead of counting it as zero", () => {
    expect(answerMetricsSummary([row("q1", 10, 1), row("old")])).toEqual({
      meanAnswerChars: 10,
      maxAnswerChars: 10,
      meanCitationsPerAnswer: 1,
      maxCitationsPerAnswer: 1,
    });
  });

  it("excludes a row carrying only one of the two measurements", () => {
    expect(answerMetricsSummary([row("q1", 10), row("q2", undefined, 4)])).toEqual({
      meanAnswerChars: null,
      maxAnswerChars: null,
      meanCitationsPerAnswer: null,
      maxCitationsPerAnswer: null,
    });
  });
});

describe("buildReport — the persisted descriptive figures", () => {
  const set: GoldenSet = { id: "metrics-set", status: "v0-draft", questions: [] };

  const row = (id: string, answerChars: number, citationCount: number): EvalResultOutcome => ({
    questionId: id,
    expectedBehavior: "answer",
    passed: true,
    sourceTypeRecall: 1,
    citationValidity: 1,
    refused: false,
    answerChars,
    citationCount,
  });

  const build = (scored: EvalResultOutcome[]) =>
    buildReport(set, {
      runId: "run-1",
      startedAt: 0,
      finishedAt: 1,
      results: scored,
      passed: scored.length,
      failed: 0,
      skipped: 0,
      budgetExceeded: false,
      scored,
      costMicroUsd: 0,
      costs: [],
    });

  it("persists the four figures beside the existing metrics", () => {
    const report = build([row("q1", 10, 1), row("q2", 20, 3)]);
    expect(report.meanAnswerChars).toBe(15);
    expect(report.maxAnswerChars).toBe(20);
    expect(report.meanCitationsPerAnswer).toBe(2);
    expect(report.maxCitationsPerAnswer).toBe(3);
    // The existing figures keep their shape and values.
    expect(report.meanSourceTypeRecall).toBe(1);
    expect(report.meanCitationValidity).toBe(1);
  });

  it("persists nulls for a scored set that measured nothing", () => {
    const report = build([]);
    expect(report.meanAnswerChars).toBeNull();
    expect(report.maxAnswerChars).toBeNull();
    expect(report.meanCitationsPerAnswer).toBeNull();
    expect(report.maxCitationsPerAnswer).toBeNull();
  });
});

describe("runGoldenSet — the measurements ride the answers the scorer read", () => {
  const question = (id: string): GoldenQuestion => ({
    id,
    question: `ask ${id}`,
    language: "en",
    expectedSourceTypes: [],
    requiredCitations: [],
    expectedBehavior: "answer",
  });

  const set: GoldenSet = {
    id: "metrics-run",
    status: "v0-draft",
    questions: [question("q1"), question("q2"), question("q3")],
  };

  const replies: Record<string, { text: string; citations: CitationFrameLike }> = {
    q1: { text: "alpha", citations: frame("L-1", "L-2") },
    q2: { text: "beta beta", citations: frame("L-1") },
  };

  const transport: ChatTransport = {
    async ask(q) {
      const reply = replies[q.id];
      if (reply === undefined) throw new Error("transport down");
      return {
        text: reply.text,
        messageId: `m-${q.id}`,
        traceId: `t-${q.id}`,
        citations: reply.citations,
      };
    },
  };

  const traces: AnswerTraceSource = {
    async eventsByMessage() {
      return [];
    },
  };

  let savedReport: { [key: string]: unknown } | undefined;
  const savedOutcomes: EvalResultOutcome[] = [];
  const ledger: RunLedger = {
    async createRun() {
      return "run-1";
    },
    async refreshRun(_runId, _label, report) {
      savedReport = report as { [key: string]: unknown };
    },
    async saveResult(_runId, _questionId, outcome) {
      savedOutcomes.push(outcome);
      return "result-1";
    },
  };

  it("records each scored answer's size and count, and aggregates them in the report", async () => {
    const deps = {
      transport,
      traces,
      ledger,
      sourceTypeOf: () => undefined,
      citationOf: () => undefined,
      budget: new Budget(undefined),
      refusalMarkers: [] as readonly string[],
      citationGrammar: GRAMMAR,
    };
    const result = await runGoldenSet(set, deps);

    expect(result.results.map((r) => [r.questionId, r.answerChars, r.citationCount])).toEqual([
      ["q1", 5, 2],
      ["q2", 9, 1],
      // A skipped question read no answer, so it carries no measurement.
      ["q3", undefined, undefined],
    ]);
    expect(savedOutcomes[0]?.answerChars).toBe(5);
    expect(savedOutcomes[0]?.citationCount).toBe(2);

    // The aggregate averages only the two answers that exist, not the skip and not
    // the third question's missing row.
    expect(savedReport?.meanAnswerChars).toBe(7);
    expect(savedReport?.maxAnswerChars).toBe(9);
    expect(savedReport?.meanCitationsPerAnswer).toBe(1.5);
    expect(savedReport?.maxCitationsPerAnswer).toBe(2);
  });
});
