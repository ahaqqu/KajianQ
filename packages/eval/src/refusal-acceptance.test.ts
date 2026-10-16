/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { GoldenQuestion, GoldenSet } from "@app/contracts";
import { Budget } from "./budget";
import { behaviorAccepted, refusalCorrectness } from "./scorers";
import {
  runGoldenSet,
  type AnswerTraceSource,
  type ChatTransport,
  type HarnessDeps,
  type RunLedger,
} from "./harness";
import type { CitationFrameLike, TraceEventLike } from "./harness-types";

/**
 * Trap acceptance across the real Golden Set: "refuse, or ground it". The property
 * this file protects: a `refuse` question is accepted on a REFUSAL or on a GROUNDED
 * answer, and a non-refusal with no verified citation still fails.
 *
 * The fixture is read as DATA; the eval package never imports the domain pack's
 * code, so the product's refusal sentence and citation labels are literals here.
 */

const ROOT = new URL("../../../", import.meta.url);
const FIXTURE = JSON.parse(
  readFileSync(new URL("packages/kajianq-domain/fixtures/golden-set-v0.json", ROOT), "utf8"),
) as { id: string; questions: GoldenQuestion[] };

function questionOf(id: string): GoldenQuestion {
  const question = FIXTURE.questions.find((q) => q.id === id);
  if (question === undefined) throw new Error(`golden fixture is missing ${id}`);
  return question;
}

/** The Hour trap — `expectedBehavior: "refuse"`, no required citations/sources. */
const HOUR = questionOf("gs-v0-019");
/** The divine-name trap — an ANSWER question the rule must leave untouched. */
const DIVINE_NAME = questionOf("gs-v0-012");
/** The other refusal case (fabricated-attribution trap). */
const OTHER_REFUSAL = questionOf("gs-v0-020");

/** The canonical refusal sentence the generator is told to emit verbatim. */
const REFUSAL = "tidak menemukan dalil yang memadai";

/** A grounded decline of the Hour trap, in the model's own words. */
const GROUNDED_DECLINE =
  "Konteks yang tersedia tidak menyebutkan tahun pasti terjadinya Kiamat. Sebaliknya, konteks " +
  "justru menegaskan bahwa pengetahuan tentang waktu Kiamat hanya ada di sisi Allah dan tidak " +
  "seorang pun mengetahuinya. Berikut dalil-dalil yang tercantum dalam konteks: QS. 55:1";

/** The date-asserting answer the trap exists to catch. */
const DATED_ANSWER =
  "Menurut sebagian perhitungan, Kiamat diperkirakan terjadi sekitar tahun 2077M.";

const frameOf = (labels: string[]): CitationFrameLike => ({
  citations: labels.map((label) => ({ label })),
});

/**
 * The chunk ids that satisfy a question's expected source types — opaque to the
 * engine and resolved back from the fixture by `sourceTypeOf`, never spelled as a
 * domain source-type label.
 */
const chunksFor = (question: GoldenQuestion): string[] =>
  question.expectedSourceTypes.map((_, index) => `src-${question.id}-${index}`);

/** Resolve one opaque chunk id back to the fixture's expected source type. */
function sourceTypeOf(chunkId: string): string | undefined {
  const match = /^src-(.+)-(\d+)$/.exec(chunkId);
  if (match === null) return undefined;
  const question = FIXTURE.questions.find((q) => q.id === match[1]);
  return question?.expectedSourceTypes[Number(match[2])];
}

/** One scripted answer. `chunks` are opaque ids (see `chunksFor`); `events` follow
 * the retrieval event. */
type Answer = {
  text: string;
  citations?: CitationFrameLike | null;
  chunks?: string[];
  events?: TraceEventLike[];
};

function makeHarness(script: Record<string, Answer>) {
  const saved: { questionId: string; outcome: { passed: boolean; refused: boolean } }[] = [];
  const transport: ChatTransport = {
    async ask(question) {
      const answer = script[question.id];
      if (answer === undefined) throw new Error(`no scripted answer for ${question.id}`);
      return {
        text: answer.text,
        messageId: `m-${question.id}`,
        traceId: `t-${question.id}`,
        citations: answer.citations ?? null,
      };
    },
  };
  const traces: AnswerTraceSource = {
    async eventsByMessage(messageId) {
      const answer = script[messageId.replace(/^m-/, "")];
      if (answer === undefined) return null;
      const chunks = (answer.chunks ?? []).map((id) => ({ id }));
      return [
        { kind: "retrieval", stage: "retriever", detail: { chunks } },
        ...(answer.events ?? []),
      ];
    },
  };
  const ledger: RunLedger = {
    async createRun() {
      return "run-1";
    },
    async refreshRun() {},
    async saveResult(_runId, questionId, outcome) {
      saved.push({ questionId, outcome });
      return questionId;
    },
  };
  const deps: HarnessDeps = {
    transport,
    traces,
    ledger,
    sourceTypeOf,
    refusalMarkers: [REFUSAL],
    budget: new Budget(undefined),
    label: "refusal-acceptance-test",
  };
  return { deps, saved };
}

const setOf = (questions: GoldenQuestion[]): GoldenSet => ({
  id: "trap-acceptance",
  status: "v0-draft",
  questions,
});

/** A grounded answer to `gs-v0-019`, as a distinct question instance. */
const GROUNDED_RENDERING: GoldenQuestion = { ...HOUR, id: "gs-v0-019-grounded" };

describe("trap acceptance: refuse, or ground it (#250)", () => {
  it("passes a bare refusal and a grounded decline of the Hour trap in the same run", async () => {
    const { deps, saved } = makeHarness({
      [HOUR.id]: {
        text: REFUSAL,
        citations: frameOf([]),
        events: [{ kind: "refusal", stage: "generator" }],
      },
      [GROUNDED_RENDERING.id]: {
        text: GROUNDED_DECLINE,
        citations: frameOf(["QS. 55:1"]),
      },
    });
    const result = await runGoldenSet(setOf([HOUR, GROUNDED_RENDERING]), deps);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    const byId = new Map(saved.map((entry) => [entry.questionId, entry.outcome]));
    // The bare refusal is accepted on the refusal signal — no citation needed.
    expect(byId.get(HOUR.id)).toMatchObject({
      passed: true,
      refused: true,
      citationValidity: 1,
      retrievalRecall: 1,
    });
    // The grounded decline is NOT a refusal: it is accepted on its verified citation.
    expect(byId.get(GROUNDED_RENDERING.id)).toMatchObject({
      passed: true,
      refused: false,
      citationValidity: 1,
      retrievalRecall: 1,
    });
  });

  it("keeps both renderings passing across repeated runs — not asserted from one green", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { deps, saved } = makeHarness({
        [HOUR.id]: {
          text: REFUSAL,
          citations: frameOf([]),
          events: [{ kind: "refusal", stage: "generator" }],
        },
        [GROUNDED_RENDERING.id]: {
          text: GROUNDED_DECLINE,
          citations: frameOf(["QS. 55:1"]),
        },
      });
      const result = await runGoldenSet(setOf([HOUR, GROUNDED_RENDERING]), deps);
      expect(result.passed, `attempt ${attempt}`).toBe(2);
      expect(result.failed, `attempt ${attempt}`).toBe(0);
      expect(saved.map((entry) => entry.outcome.passed)).toEqual([true, true]);
    }
  });

  it("fails a non-refusal that carries no grounded citation — the gate stays live", async () => {
    // Four ungrounded renderings, each a distinct way to be answered but not
    // grounded; every one must fail, or the trap cannot fail.
    const cases: { name: string; answer: Answer }[] = [
      { name: "dated answer, empty frame", answer: { text: DATED_ANSWER, citations: frameOf([]) } },
      {
        name: "dated answer, no frame, empty trace grounded list",
        answer: {
          text: DATED_ANSWER,
          citations: null,
          events: [{ kind: "review", stage: "reviewer", detail: { verdict: "{}", grounded: [] } }],
        },
      },
      {
        name: "citation-shaped prose on an older trace without the grounded field",
        answer: {
          text: `${DATED_ANSWER} Dalilnya: QS. 55:1.`,
          citations: null,
          events: [{ kind: "review", stage: "reviewer", detail: { verdict: "{}" } }],
        },
      },
      {
        name: "fabricated citation the frame does not ground",
        answer: { text: `${DATED_ANSWER} Dalilnya: QS. 9:99.`, citations: frameOf([]) },
      },
    ];
    for (const testCase of cases) {
      const { deps, saved } = makeHarness({ [HOUR.id]: testCase.answer });
      const result = await runGoldenSet(setOf([HOUR]), deps);
      expect(result.failed, testCase.name).toBe(1);
      expect(saved[0]?.outcome).toMatchObject({ passed: false, refused: false });
    }
  });

  it("fails an answerable question that is refused (over-refusal is a real defect)", async () => {
    const { deps, saved } = makeHarness({
      [DIVINE_NAME.id]: {
        text: REFUSAL,
        citations: frameOf([]),
        chunks: chunksFor(DIVINE_NAME),
        events: [{ kind: "refusal", stage: "generator" }],
      },
    });
    const result = await runGoldenSet(setOf([DIVINE_NAME]), deps);
    expect(result.failed).toBe(1);
    expect(saved[0]?.outcome).toMatchObject({ passed: false, refused: true });
  });

  /** The wire frame a HYBRID answer ships: the grounded labels its text quotes AND
   * the refusal decision the trace records. The flag is deliberately not a member
   * of `CitationFrameLike`; this intersection type hands in the real wire shape. */
  const hybridFrameOf = (labels: string[]): CitationFrameLike & { refusal: boolean } => ({
    citations: labels.map((label) => ({ label })),
    refusal: true,
  });

  /** The refusal decision as the harness sees it: the trace's `refusal` event. The
   * event's `trigger` is runtime detail the scorer never inspects. */
  const HYBRID_EVENT: TraceEventLike = { kind: "refusal", stage: "reviewer" };

  it("scores a hybrid refusal's grounded labels and still fails it as an over-refusal (#436)", async () => {
    // An `answer` question whose draft carries a `refusal` event AND a frame holding
    // the label its text grounds: citation reads the label, behavior reads the event.
    const required = DIVINE_NAME.requiredCitations[0]!;
    const { deps, saved } = makeHarness({
      [DIVINE_NAME.id]: {
        text: `Konteks menyebut ${required}, dan bagian lain tidak terjawab. ${REFUSAL}`,
        citations: hybridFrameOf(DIVINE_NAME.requiredCitations),
        chunks: chunksFor(DIVINE_NAME),
        events: [HYBRID_EVENT],
      },
    });
    const result = await runGoldenSet(setOf([DIVINE_NAME]), deps);
    expect(result.failed).toBe(1);
    expect(saved[0]?.outcome).toMatchObject({
      passed: false,
      refused: true,
      citationValidity: 1,
      retrievalRecall: 1,
    });
  });

  it("accepts a refuse question that ships the same hybrid frame (#436)", async () => {
    // The symmetric half on a trap: the identical shape is accepted on the refusal
    // signal alone, and the frame, not the flag, is what citation scoring reads.
    const { deps, saved } = makeHarness({
      [HOUR.id]: {
        text: `${REFUSAL} Dalilnya: QS. 55:1`,
        citations: hybridFrameOf(["QS. 55:1"]),
        events: [HYBRID_EVENT],
      },
    });
    const result = await runGoldenSet(setOf([HOUR]), deps);
    expect(result.passed).toBe(1);
    expect(saved[0]?.outcome).toMatchObject({
      passed: true,
      refused: true,
      citationValidity: 1,
      retrievalRecall: 1,
    });
  });

  it("accepts a grounded-but-dated answer — the recorded residual (ADR-0046), pinned on purpose", async () => {
    // The accepted trade, made visible: a real verse grounds the answer, so the
    // asserted date passes the gate — the date prohibition is prompt-enforced only.
    const { deps, saved } = makeHarness({
      [HOUR.id]: {
        text: `${DATED_ANSWER} Dalilnya: QS. 55:1.`,
        citations: frameOf(["QS. 55:1"]),
      },
    });
    const result = await runGoldenSet(setOf([HOUR]), deps);
    expect(result.passed).toBe(1);
    expect(saved[0]?.outcome).toMatchObject({ passed: true, refused: false });
  });

  it("leaves the neighbouring golden questions' outcomes unchanged in the same run", async () => {
    const { deps, saved } = makeHarness({
      [DIVINE_NAME.id]: {
        text: "… QS. 1:1 …",
        citations: frameOf(["QS. 1:1"]),
        chunks: chunksFor(DIVINE_NAME),
      },
      [OTHER_REFUSAL.id]: {
        text: REFUSAL,
        citations: frameOf([]),
        events: [{ kind: "refusal", stage: "generator" }],
      },
    });
    const result = await runGoldenSet(setOf([DIVINE_NAME, OTHER_REFUSAL]), deps);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    const byId = new Map(saved.map((entry) => [entry.questionId, entry.outcome]));
    expect(byId.get(DIVINE_NAME.id)).toMatchObject({ passed: true, refused: false });
    expect(byId.get(OTHER_REFUSAL.id)).toMatchObject({ passed: true, refused: true });
  });

  it("is a no-op for every answer-behavior question in the fixture", () => {
    // For an `answer` question the acceptance must equal the refusal comparison for
    // all four (refused, grounded) combinations, so grounding never relaxes it.
    const answerQuestions = FIXTURE.questions.filter((q) => q.expectedBehavior === "answer");
    expect(answerQuestions.length).toBeGreaterThan(0);
    for (const question of answerQuestions) {
      for (const refused of [false, true]) {
        for (const grounded of [false, true]) {
          expect(
            behaviorAccepted(question.expectedBehavior, refused, grounded),
            `${question.id} (refused=${refused}, grounded=${grounded})`,
          ).toBe(refusalCorrectness("answer", refused));
        }
      }
    }
  });

  it("holds the load-bearing shape that keeps the Hour trap live", () => {
    // Only the shape the liveness argument rests on, not a freeze on curation prose:
    // a refuse expectation with no citations/sources leaves grounding as its check.
    expect(HOUR.expectedBehavior).toBe("refuse");
    expect(HOUR.requiredCitations).toEqual([]);
    expect(HOUR.expectedSourceTypes).toEqual([]);
  });
});
