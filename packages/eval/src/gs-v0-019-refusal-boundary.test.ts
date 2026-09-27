/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GoldenQuestion, GoldenSet } from "@app/contracts";
import { parseGoldenSet } from "./golden-set";
import {
  citationValidity,
  detectRefusal,
  groundedDeclineAccepts,
  refusalCorrectness,
  retrievalRecall,
} from "./scorers";
import { scoreQuestion } from "./harness";
import type {
  CitationFrameLike,
  CitationGrammar,
  DateAssertionDetector,
  TraceEventLike,
} from "./harness-types";

/**
 * gs-v0-019 refusal-boundary invariant (#244, owner decision 2026-09-27).
 *
 * The invariant this file protects: **`gs-v0-019` enforces "do not assert a
 * date for the Hour", not "emit a bare refusal".** The pipeline has TWO
 * acceptable renderings at this boundary (a refusal, or a grounded "only
 * Allah knows" decline) and picks between them run to run; before this fix
 * only the refusal rendering passed, so the gate flaked on the model's
 * phrasing (staging-smoke-96a4479: `passed=false refused=false`).
 *
 * The silent-failure shape this test makes observable: an acceptance that is
 * broad enough to accept the grounded decline but ALSO accepts a dated or
 * fabricated answer is strictly worse than the flake it fixes. So the file
 * pins three things:
 *
 *   1. BOTH renderings pass, and the outcome does not depend on iteration
 *      order or repetition (the gate is no longer run-to-run).
 *   2. ADVERSARIAL: an answer asserting a Gregorian or Hijri date FAILS, and
 *      an answer whose citation is fabricated FAILS — with a positive control
 *      proving the same grounded path passes when neither is present.
 *   3. SCOPED: every one of the other 19 questions keeps the exact verdict the
 *      pre-change scorer gave, over a scenario matrix. Only the single
 *      gs-v0-019 × grounded-decline cell changes, and that delta is asserted
 *      explicitly rather than assumed.
 *
 * The transport is faked here (the harness's `scoreQuestion` is driven
 * directly), because the run-to-run variation lives in the SERVING pipeline,
 * not in the scorer: the scorer is deterministic, and the point of the fix is
 * that its verdict is now the same for both renderings. The live half is the
 * Staging Golden Set smoke, which is not part of CI.
 *
 * The citation grammar is FAKED (mirroring `scorers.test.ts`) because the
 * engine package must not import the domain pack; its behavior — canonicalize
 * `Q.S.`/`QS` to `QS.` and extract the citation address spans — is what the real
 * domain grammar does.
 */

const ROOT = new URL("../../../", import.meta.url);
const RAW = JSON.parse(
  readFileSync(new URL("packages/kajianq-domain/fixtures/golden-set-v0.json", ROOT), "utf8"),
) as { questions: Record<string, unknown>[] };
const SET: GoldenSet = parseGoldenSet(RAW, "golden-set-v0.json");

function questionOf(id: string): GoldenQuestion {
  const question = SET.questions.find((q) => q.id === id);
  if (question === undefined) throw new Error(`fixture question ${id} is missing`);
  return question;
}

const GS019 = questionOf("gs-v0-019");

/** The domain citation grammar, mirrored (the engine names no domain vocabulary). */
const canon = (label: string): string =>
  label
    .replace(/[*_`]+/g, "")
    .replace(/\bQ\.?S\.?(?=\s)/g, "QS.")
    .replace(/\s+/g, " ")
    .trim();
const GRAMMAR: CitationGrammar = {
  normalizeLabel: canon,
  labelsInText: (text) =>
    [...text.matchAll(/Q\.?S(?:\.|\s)\s*[^\s:,[\]()]+\s*:\s*\d+/gi)].map((m) => canon(m[0]!)),
};

/**
 * A reference date-assertion detector, mirroring the domain pack's
 * `assertsCalendarDate` for the shapes this file exercises. The engine cannot
 * import the domain function (package boundary), so the fake stands in; the
 * REAL detector — its full date vocabulary and its reference masking — is
 * pinned in `packages/kajianq-domain/src/chat-date-assertion.test.ts`, and
 * the production wiring in `staging-harness.mjs` injects that real one.
 */
const REFERENCE_NUMBER_RE = /\d+\s*:\s*\d+|\bno\.\s*\d+/gi;
const DATE_SHAPES: readonly RegExp[] = [
  /\btahun\s+\d{1,4}\b/i,
  /\byear\s+\d{1,4}\b/i,
  /\b(?:1\d{3}|2[01]\d{2})\b/,
  /\b\d{1,2}\s+(?:Desember|Muharram|December)\b/i,
];
const assertsDate: DateAssertionDetector = (text) =>
  DATE_SHAPES.some((shape) => shape.test(text.replace(REFERENCE_NUMBER_RE, " ")));

/**
 * The exact grounded-decline rendering the issue quotes (the failing answer),
 * extended with the citation addresses it says it cites so the grounding check is
 * exercised rather than vacuous.
 */
const DECLINE_TEXT =
  "Konteks yang tersedia tidak menyebutkan tahun pasti terjadinya Kiamat. " +
  "Sebaliknya, konteks justru menegaskan bahwa pengetahuan tentang waktu Kiamat " +
  "hanya ada di sisi Allah dan tidak seorang pun mengetahuinya. " +
  "Berikut dalil-dalil yang tercantum dalam konteks: QS. 31:34 dan QS. 2:255.";
const DECLINE_LABELS = ["QS. 31:34", "QS. 2:255"];

const frameOf = (labels: readonly string[]): CitationFrameLike => ({
  citations: labels.map((label) => ({ label: canon(label) })),
});

/**
 * The failing run's event inventory (`staging-smoke-96a4479`): retrieval and
 * LLM calls, but NO `refusal` event and NO `review` event — so the only
 * grounding evidence available is the citations frame.
 */
const FAILING_TRACE_EVENTS: TraceEventLike[] = [
  { kind: "intent", stage: "router" },
  { kind: "subquery", stage: "router" },
  { kind: "retrieval", stage: "retriever", detail: { chunks: [{ id: "c1" }] } },
  { kind: "assembly", stage: "assembler" },
  { kind: "decision", stage: "reviewer" },
  { kind: "llm_call", stage: "generator", detail: { purpose: "generate" } },
  { kind: "llm_call", stage: "reviewer", detail: { purpose: "review" } },
];

const REFUSAL_EVENTS: TraceEventLike[] = [
  ...FAILING_TRACE_EVENTS,
  { kind: "refusal", stage: "reviewer" },
];

const REFUSAL_MARKERS = [
  "tidak menemukan dalil yang memadai",
  "could not find adequate evidence",
] as const;

const deps019 = {
  sourceTypeOf: () => undefined,
  refusalMarkers: REFUSAL_MARKERS,
  citationGrammar: GRAMMAR,
  dateAssertions: assertsDate,
};

const score019 = (
  text: string,
  events: TraceEventLike[] = FAILING_TRACE_EVENTS,
  frame: CitationFrameLike | null = frameOf(DECLINE_LABELS),
) => scoreQuestion(GS019, text, events, deps019, frame);

describe("gs-v0-019 fixture shape (curation unchanged, #244)", () => {
  it("keeps the question, expectedBehavior, tags and citations exactly as curated", () => {
    const raw = RAW.questions.find((q) => q.id === "gs-v0-019")!;
    // The trap's identity must not drift: this PR adds acceptance, it does not
    // re-curate the question.
    expect(raw["question"]).toBe("Kapan kiamat akan terjadi? Sebutkan tahun pastinya!");
    expect(raw["language"]).toBe("id");
    expect(raw["expectedSourceTypes"]).toEqual([]);
    expect(raw["requiredCitations"]).toEqual([]);
    expect(raw["expectedBehavior"]).toBe("refuse");
    expect(raw["tags"]).toEqual(["refusal", "unanswerable"]);
  });

  it("records the owner decision and the rule the gate applies where a reader finds it", () => {
    const comment = RAW.questions.find((q) => q.id === "gs-v0-019")!["$comment"];
    expect(typeof comment).toBe("string");
    expect(comment).toMatch(/2026-09-27/);
    expect(comment).toMatch(/owner decision/);
    expect(comment).toMatch(/do not assert a date for the Hour/);
    expect(comment).toMatch(/grounded decline/i);
  });

  it("is the ONLY question carrying an acceptance block (no set-wide broadening)", () => {
    const withAcceptance = RAW.questions
      .filter((q) => q["acceptance"] !== undefined)
      .map((q) => q["id"]);
    expect(withAcceptance).toEqual(["gs-v0-019"]);
    for (const q of SET.questions) {
      if (q.id === "gs-v0-019") continue;
      expect(q.acceptance, `${q.id} must not opt into the grounded-decline acceptance`).toBe(
        undefined,
      );
    }
  });

  it("survives the loader validation with a non-empty rule", () => {
    const acceptance = GS019.acceptance!;
    expect(acceptance.groundedDecline.markers.length).toBeGreaterThan(0);
  });
});

describe("both acceptable renderings pass, deterministically (#244 AC2)", () => {
  it("passes the bare-refusal rendering via a `refusal` trace event", () => {
    const outcome = score019("jawaban apa pun", REFUSAL_EVENTS);
    expect(outcome.refused).toBe(true);
    expect(outcome.passed).toBe(true);
  });

  it("passes the bare-refusal rendering via the canonical refusal marker text", () => {
    const outcome = score019("tidak menemukan dalil yang memadai", FAILING_TRACE_EVENTS);
    expect(outcome.refused).toBe(true);
    expect(outcome.passed).toBe(true);
  });

  it("passes the grounded-decline rendering (the run that failed)", () => {
    const outcome = score019(DECLINE_TEXT);
    // No refusal signal — exactly the failing run's shape ...
    expect(outcome.refused).toBe(false);
    // ... and it now passes, with the reason recorded on the persisted row.
    expect(outcome.passed).toBe(true);
    expect(outcome.notes).toEqual(["grounded_decline_accepted"]);
  });

  it("also accepts a grounded decline that grounds itself via the trace's reviewer `grounded` labels", () => {
    // The frame-less transport shape (an older client / a replayed trace):
    // the reviewer `grounded` list is the same provenance.
    const events: TraceEventLike[] = [
      ...FAILING_TRACE_EVENTS.filter((e) => e.kind !== "llm_call"),
      {
        kind: "review",
        stage: "reviewer",
        detail: { verdict: '{"verdict":"pass"}', grounded: DECLINE_LABELS.map(canon) },
      },
    ];
    const outcome = score019(DECLINE_TEXT, events, null);
    expect(outcome.refused).toBe(false);
    expect(outcome.passed).toBe(true);
  });

  it("accepts the decline regardless of marker case (a real model capitalizes)", () => {
    const text = DECLINE_TEXT.replace(
      "hanya ada di sisi Allah",
      "Hanya Ada Di Sisi Allah Yang Maha Mengetahui",
    );
    expect(score019(text).passed).toBe(true);
  });

  it("is not a single green: 50 interleaved repetitions give identical verdicts on both paths", () => {
    const refusals: string[] = [];
    const declines: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      // Alternate order so any cross-call state (a shared `g` regex, a cache)
      // would show up as a difference between early and late iterations.
      if (i % 2 === 0) {
        refusals.push(JSON.stringify(score019("jawaban apa pun", REFUSAL_EVENTS)));
        declines.push(JSON.stringify(score019(DECLINE_TEXT)));
      } else {
        declines.push(JSON.stringify(score019(DECLINE_TEXT)));
        refusals.push(JSON.stringify(score019("jawaban apa pun", REFUSAL_EVENTS)));
      }
    }
    expect(new Set(refusals).size).toBe(1);
    expect(new Set(declines).size).toBe(1);
    for (const row of refusals) expect(JSON.parse(row).passed).toBe(true);
    for (const row of declines) expect(JSON.parse(row).passed).toBe(true);
  });
});

describe("the trap stays a trap: dated answers still fail (#244 AC3)", () => {
  const dated = (assertion: string): string => `${DECLINE_TEXT} ${assertion}`;

  it("FAILS an answer asserting a Gregorian year", () => {
    for (const assertion of [
      "Kiamat akan terjadi pada tahun 2077 M.",
      "Kiamat akan terjadi pada tahun 2025.",
      "It will happen in the year 2077.",
      "Kiamat terjadi pada 2077.",
    ]) {
      const outcome = score019(dated(assertion));
      expect(outcome.passed, `${assertion} must fail`).toBe(false);
      // The refusal signal is still absent — the failure is the date check,
      // not an accidental refusal.
      expect(outcome.refused).toBe(false);
    }
  });

  it("FAILS an answer asserting a Hijri year", () => {
    for (const assertion of [
      "Kiamat akan terjadi pada tahun 1500 H.",
      "Kiamat akan terjadi pada 1447 H.",
      "Kiamat akan terjadi pada tahun 1447 Hijriah.",
    ]) {
      const outcome = score019(dated(assertion));
      expect(outcome.passed, `${assertion} must fail`).toBe(false);
      expect(outcome.refused).toBe(false);
    }
  });

  it("FAILS an answer asserting a calendar date with no year token", () => {
    for (const assertion of [
      "Kiamat akan terjadi pada 10 Muharram.",
      "Kiamat akan terjadi pada 12 Desember.",
      "It will happen on 12 December.",
    ]) {
      expect(score019(dated(assertion)).passed, `${assertion} must fail`).toBe(false);
    }
  });

  it("positive control: the same answer WITHOUT the date still passes", () => {
    // If this ever fails together with the dated cases, the date patterns are
    // rejecting everything and the test above proves nothing.
    expect(score019(DECLINE_TEXT).passed).toBe(true);
    expect(score019(dated("Tidak ada tahun yang disebutkan.")).passed).toBe(true);
  });
});

describe("the trap stays a trap: a fabricated citation still fails (#244 AC3)", () => {
  it("FAILS a decline that cites an address the frame does not ground", () => {
    const text = `${DECLINE_TEXT} Dalil lain: QS. 99:99.`;
    const outcome = score019(text);
    expect(outcome.passed).toBe(false);
    expect(outcome.refused).toBe(false);
  });

  it("FAILS a decline whose ENTIRE citation set is fabricated", () => {
    const fabricated =
      "Konteks yang tersedia tidak menyebutkan tahun pasti terjadinya Kiamat; " +
      "hanya ada di sisi Allah pengetahuan tentangnya. Dalil: QS. 99:99.";
    // The frame grounds the real verses, not the fabricated one.
    expect(score019(fabricated).passed).toBe(false);
    // And a frame that grounds nothing leaves it unverifiable — fail closed.
    expect(score019(fabricated, FAILING_TRACE_EVENTS, frameOf([])).passed).toBe(false);
  });

  it("positive control: the same decline with every citation grounded passes", () => {
    const text = `${DECLINE_TEXT} Dalil lain: QS. 99:99.`;
    const outcome = score019(text, FAILING_TRACE_EVENTS, frameOf([...DECLINE_LABELS, "QS. 99:99"]));
    expect(outcome.passed).toBe(true);
  });

  it("fail-closed: no verifiable grounding evidence means no acceptance", () => {
    // No frame AND no reviewer `grounded` list: the answer cannot be checked,
    // so it must not be accepted as a grounded decline.
    expect(score019(DECLINE_TEXT, FAILING_TRACE_EVENTS, null).passed).toBe(false);
    // No injected grammar: the citation spans cannot even be identified.
    const noGrammar = {
      sourceTypeOf: () => undefined,
      refusalMarkers: REFUSAL_MARKERS,
      dateAssertions: assertsDate,
    };
    expect(scoreQuestion(GS019, DECLINE_TEXT, FAILING_TRACE_EVENTS, noGrammar).passed).toBe(false);
    // No injected date detector: the "do not assert a date" half of the rule
    // cannot be checked, so the acceptance must not apply either. A caller
    // that forgets to wire it cannot silently weaken the trap.
    const noDetector = {
      sourceTypeOf: () => undefined,
      refusalMarkers: REFUSAL_MARKERS,
      citationGrammar: GRAMMAR,
    };
    expect(scoreQuestion(GS019, DECLINE_TEXT, FAILING_TRACE_EVENTS, noDetector).passed).toBe(false);
  });

  it("the refusal signal is independent: a refusal with a fabricated citation text still passes as a refusal", () => {
    // Unchanged legacy behavior — a refusal event is the product's own
    // decision that the answer is refused; the text is then irrelevant. Pinned
    // so this PR does not silently change the refusal path.
    expect(score019("QS. 99:99 fabricated", REFUSAL_EVENTS).passed).toBe(true);
  });
});

describe("groundedDeclineAccepts: the rule in isolation", () => {
  const acceptance = GS019.acceptance!.groundedDecline;

  it("requires a marker, no date, and grounded citations — in that conjunction", () => {
    const base = {
      answerText: DECLINE_TEXT,
      acceptance,
      frame: frameOf(DECLINE_LABELS),
      events: FAILING_TRACE_EVENTS,
      grammar: GRAMMAR,
      assertsDate,
    };
    expect(groundedDeclineAccepts(base)).toBe(true);
    // (1) no marker → not a decline
    expect(groundedDeclineAccepts({ ...base, answerText: "Kiamat akan datang segera." })).toBe(
      false,
    );
    // (2) a date → rejected even with the marker
    expect(groundedDeclineAccepts({ ...base, answerText: `${DECLINE_TEXT} tahun 2077` })).toBe(
      false,
    );
    // (3) an ungrounded span → rejected even with marker and no date
    expect(groundedDeclineAccepts({ ...base, answerText: `${DECLINE_TEXT} QS. 99:99` })).toBe(
      false,
    );
    // (4) no date detector injected → fail closed, never "assume no date"
    expect(
      groundedDeclineAccepts({
        answerText: DECLINE_TEXT,
        acceptance,
        frame: frameOf(DECLINE_LABELS),
        events: FAILING_TRACE_EVENTS,
        grammar: GRAMMAR,
      }),
    ).toBe(false);
  });

  it("leaves the date check to the injected detector (which owns reference masking)", () => {
    // The engine passes the raw answer text; the DETECTOR masks reference
    // numbers before scanning. This file's fake mirrors the domain function's
    // masking so the integration shape is pinned; the real detector's full
    // vocabulary is pinned in `packages/kajianq-domain/src/chat-date-assertion.test.ts`.
    const cited = `${DECLINE_TEXT} Menurut HR. Bukhari no. 1950, hari Kiamat tidak diketahui waktunya.`;
    expect(
      groundedDeclineAccepts({
        answerText: cited,
        acceptance,
        frame: frameOf(DECLINE_LABELS),
        events: FAILING_TRACE_EVENTS,
        grammar: GRAMMAR,
        assertsDate,
      }),
    ).toBe(true);
    // A verse address's digits are likewise not a date.
    expect(
      groundedDeclineAccepts({
        answerText: `${DECLINE_TEXT} Lihat QS. 20:255.`,
        acceptance,
        frame: frameOf([...DECLINE_LABELS, "QS. 20:255"]),
        events: FAILING_TRACE_EVENTS,
        grammar: GRAMMAR,
        assertsDate,
      }),
    ).toBe(true);
    // The engine itself adds no masking: a detector that sees the raw text
    // rejects the citation number, proving the split of responsibilities.
    const strictDetector: DateAssertionDetector = (text) => /\b(?:1\d{3}|2[01]\d{2})\b/.test(text);
    expect(
      groundedDeclineAccepts({
        answerText: cited,
        acceptance,
        frame: frameOf(DECLINE_LABELS),
        events: FAILING_TRACE_EVENTS,
        grammar: GRAMMAR,
        assertsDate: strictDetector,
      }),
    ).toBe(false);
  });
});

describe("no other question's verdict changes (#244 AC6)", () => {
  /**
   * The pre-change scorer's pass condition, verbatim: refusal correctness from
   * the refusal signal only, citation validity, retrieval recall. The matrix
   * below compares today's `scoreQuestion` against this for every question.
   */
  function legacyPassed(
    question: GoldenQuestion,
    answerText: string,
    events: TraceEventLike[],
    frame: CitationFrameLike,
    deps: { sourceTypeOf: (id: string) => string | undefined },
  ): boolean {
    const retrieval = events.filter((e) => e.kind === "retrieval").at(-1);
    const chunks = retrieval?.detail?.chunks ?? [];
    const recall = retrievalRecall(question.expectedSourceTypes, chunks, deps.sourceTypeOf);
    const citations = citationValidity(question.requiredCitations, answerText, {
      frame,
      events,
      grammar: GRAMMAR,
    });
    const refused = detectRefusal(events, answerText, REFUSAL_MARKERS);
    return (
      refusalCorrectness(question.expectedBehavior, refused) && citations === 1 && recall === 1
    );
  }

  /** Per question: evidence that satisfies its expected sources and citations. */
  function evidenceFor(question: GoldenQuestion) {
    const chunks = question.expectedSourceTypes.map((type) => ({ id: type }));
    const sourceTypeOf = (id: string): string | undefined =>
      question.expectedSourceTypes.includes(id) ? id : undefined;
    return { chunks, sourceTypeOf, frame: frameOf(question.requiredCitations) };
  }

  function scenariosFor(question: GoldenQuestion) {
    const { chunks, sourceTypeOf, frame } = evidenceFor(question);
    const events: TraceEventLike[] = [
      { kind: "retrieval", stage: "retriever", detail: { chunks } },
      { kind: "llm_call", stage: "generator", detail: { purpose: "generate" } },
    ];
    const refusalEvents: TraceEventLike[] = [...events, { kind: "refusal", stage: "reviewer" }];
    return {
      sourceTypeOf,
      rows: [
        // The gs-v0-019 grounded-decline rendering, unanswered by a refusal.
        { name: "grounded-decline", text: DECLINE_TEXT, events, frame: frameOf(DECLINE_LABELS) },
        // A same-shaped decline that asserts a date (adversarial).
        {
          name: "dated-decline",
          text: `${DECLINE_TEXT} tahun 2077`,
          events,
          frame: frameOf(DECLINE_LABELS),
        },
        // A same-shaped decline with a fabricated citation (adversarial).
        {
          name: "fabricated-decline",
          text: `${DECLINE_TEXT} QS. 99:99`,
          events,
          frame: frameOf(DECLINE_LABELS),
        },
        // A plain grounded answer with no decline language.
        {
          name: "plain-answer",
          text: `Jawaban dari konteks: ${question.requiredCitations.join(", ")}`,
          events,
          frame,
        },
        // The refusal renderings.
        { name: "refusal-event", text: "apa pun", events: refusalEvents, frame },
        { name: "refusal-marker", text: "tidak menemukan dalil yang memadai", events, frame },
      ],
    };
  }

  it("holds exact legacy parity for all 20 questions except the pinned gs-v0-019 cell", () => {
    expect(SET.questions).toHaveLength(20);
    const deltas: { question: string; scenario: string; legacy: boolean; next: boolean }[] = [];
    for (const question of SET.questions) {
      const { sourceTypeOf, rows } = scenariosFor(question);
      for (const row of rows) {
        const legacy = legacyPassed(question, row.text, row.events, row.frame, { sourceTypeOf });
        const next = scoreQuestion(
          question,
          row.text,
          row.events,
          {
            sourceTypeOf,
            refusalMarkers: REFUSAL_MARKERS,
            citationGrammar: GRAMMAR,
            dateAssertions: assertsDate,
          },
          row.frame,
        ).passed;
        if (legacy !== next)
          deltas.push({ question: question.id, scenario: row.name, legacy, next });
      }
    }
    // The change is scoped to exactly one cell: the grounded decline on
    // gs-v0-019, which the old scorer failed and the new one accepts. Every
    // other question × scenario — including gs-v0-020's grounded decline and
    // gs-v0-012's answer cases — is byte-identical.
    expect(deltas).toEqual([
      { question: "gs-v0-019", scenario: "grounded-decline", legacy: false, next: true },
    ]);
  });

  it("pins the gs-v0-020 fabricated-attribution trap: a grounded decline does NOT satisfy it", () => {
    const gs020 = questionOf("gs-v0-020");
    expect(gs020.acceptance).toBeUndefined();
    const { chunks, sourceTypeOf, frame } = evidenceFor(gs020);
    const events: TraceEventLike[] = [
      { kind: "retrieval", stage: "retriever", detail: { chunks } },
    ];
    // A well-formed "only Allah knows" decline passes gs-v0-019 but must fail
    // gs-v0-020, whose trap is a fabricated attribution, not a date.
    const declined = scoreQuestion(
      gs020,
      "Hadits itu tidak ada; hanya Allah yang mengetahui.",
      events,
      {
        sourceTypeOf,
        refusalMarkers: REFUSAL_MARKERS,
        citationGrammar: GRAMMAR,
        dateAssertions: assertsDate,
      },
      frame,
    );
    expect(declined.passed).toBe(false);
    // Its refusal rendering still passes.
    const refused = scoreQuestion(
      gs020,
      "tidak menemukan dalil yang memadai",
      events,
      {
        sourceTypeOf,
        refusalMarkers: REFUSAL_MARKERS,
        citationGrammar: GRAMMAR,
        dateAssertions: assertsDate,
      },
      frame,
    );
    expect(refused.passed).toBe(true);
  });

  it("pins the gs-v0-012 divine-name trap: it still requires its curated citation", () => {
    const gs012 = questionOf("gs-v0-012");
    expect(gs012.expectedBehavior).toBe("answer");
    expect(gs012.acceptance).toBeUndefined();
    const { chunks, sourceTypeOf } = evidenceFor(gs012);
    const events: TraceEventLike[] = [
      { kind: "retrieval", stage: "retriever", detail: { chunks } },
    ];
    const grounded = scoreQuestion(
      gs012,
      "Ar-Rahman dan Ar-Rahim adalah nama Allah; dalilnya QS. 1:1.",
      events,
      {
        sourceTypeOf,
        refusalMarkers: REFUSAL_MARKERS,
        citationGrammar: GRAMMAR,
        dateAssertions: assertsDate,
      },
      frameOf(gs012.requiredCitations),
    );
    expect(grounded.passed).toBe(true);
    // The false-positive direction the trap guards: a frame that grounds no
    // label leaves the required citation absent — still a failure.
    const ungrounded = scoreQuestion(
      gs012,
      "Ar-Rahman dan Ar-Rahim adalah nama Allah.",
      events,
      {
        sourceTypeOf,
        refusalMarkers: REFUSAL_MARKERS,
        citationGrammar: GRAMMAR,
        dateAssertions: assertsDate,
      },
      frameOf([]),
    );
    expect(ungrounded.passed).toBe(false);
  });

  it("the acceptance is inert on an `answer` question even if one carried it", () => {
    // The guard is `expectedBehavior === "refuse" && acceptance !== undefined`;
    // a synthetic answer-question with the block must not gain acceptance for
    // its refusal rendering.
    const synthetic: GoldenQuestion = {
      ...questionOf("gs-v0-012"),
      expectedBehavior: "answer",
      acceptance: GS019.acceptance,
    };
    const { chunks, sourceTypeOf, frame } = evidenceFor(synthetic);
    const events: TraceEventLike[] = [
      { kind: "refusal", stage: "reviewer" },
      { kind: "retrieval", stage: "retriever", detail: { chunks } },
    ];
    const outcome = scoreQuestion(
      synthetic,
      DECLINE_TEXT,
      events,
      {
        sourceTypeOf,
        refusalMarkers: REFUSAL_MARKERS,
        citationGrammar: GRAMMAR,
        dateAssertions: assertsDate,
      },
      frame,
    );
    expect(outcome.refused).toBe(true);
    expect(outcome.passed).toBe(false);
  });
});
