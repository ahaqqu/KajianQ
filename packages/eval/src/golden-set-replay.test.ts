/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { GoldenQuestion } from "@app/contracts";
import { addressesNamedBy, normalizeCitationLabel } from "@app/kajianq-domain";
import { scoreQuestion } from "./harness";
import type { CitationGrammar, TraceEventLike } from "./harness-types";

/**
 * Deterministic replay of the run the collection-name spelling fold was measured
 * on (`packages/kajianq-domain/fixtures/golden-set-v0-replay.json` — the snapshot's
 * own `$comment` states what it carries and what a replay can and cannot show).
 *
 * The grammar is the domain pack's own — the same functions the staging
 * composition root injects — and the requirements are read from the Golden Set at
 * head, not from the replay snapshot's pre-folded copy: a stub that stripped only
 * the grade would flip `gs-v0-004` red, so a normaliser weaker than production
 * cannot pass this test. The snapshot's own `required` entries are asserted to be
 * the comparison form of the head fixture below. The domain-side
 * `chat-citation-replay` test re-derives both sides from the recorded answer texts
 * and retrieved chunks; this file only replays them. With a frame on every row, the
 * text path is unreachable, which is why `labelsInText` is empty.
 */

type RetrievalRow = { label: string | null; sourceType: string | null; backed: boolean };

type Row = {
  questionId: string;
  expectedBehavior: "answer" | "refuse";
  expectedSourceTypes: string[];
  required: string[];
  answer: string;
  refused: boolean;
  retrieved: RetrievalRow[];
  evidence: string[];
  recorded: {
    passed: boolean;
    citationValidity: number;
    retrievalRecall: number;
    refused: boolean;
  };
};

const ROOT = new URL("../../../", import.meta.url);
const FIXTURE = JSON.parse(
  readFileSync(new URL("packages/kajianq-domain/fixtures/golden-set-v0-replay.json", ROOT), "utf8"),
) as { id: string; run: string; base: string; rows: Row[] };
const ROWS = FIXTURE.rows;

const HEAD = JSON.parse(
  readFileSync(new URL("packages/kajianq-domain/fixtures/golden-set-v0.json", ROOT), "utf8"),
) as { questions: { id: string; requiredCitations: string[] }[] };
const HEAD_REQUIRED = new Map(HEAD.questions.map((q) => [q.id, q.requiredCitations]));

/** The real comparison form, injected exactly as the staging composition root does. */
const GRAMMAR: CitationGrammar = {
  normalizeLabel: normalizeCitationLabel,
  labelsInText: () => [],
  addressesNamedBy,
};

/** The requirement the Golden Set carries at head for this row. */
function requiredOf(row: Row): string[] {
  const required = HEAD_REQUIRED.get(row.questionId);
  if (required === undefined) throw new Error(`the Golden Set carries no ${row.questionId}`);
  return required;
}

/** The trace events the scorer reads, rebuilt from the fixture's own fields. */
function eventsOf(row: Row): TraceEventLike[] {
  const events: TraceEventLike[] = [
    {
      kind: "retrieval",
      stage: "retriever",
      detail: { chunks: row.retrieved.map((_, index) => ({ id: `c${index}` })) },
    },
  ];
  if (row.refused) {
    events.push({ kind: "refusal", stage: "postprocess", detail: { key: "generator_refusal" } });
  }
  return events;
}

/** The question as the harness reads it, from the fixture's own fields. */
function questionOf(row: Row): GoldenQuestion {
  return {
    id: row.questionId,
    question: row.questionId,
    language: "id",
    expectedSourceTypes: row.expectedSourceTypes,
    requiredCitations: requiredOf(row),
    expectedBehavior: row.expectedBehavior,
  };
}

/** One row scored by the shipped scorer with the head build's evidence. */
function headOutcome(row: Row): ReturnType<typeof scoreQuestion> {
  return scoreQuestion(
    questionOf(row),
    row.answer,
    eventsOf(row),
    {
      sourceTypeOf: (id) => row.retrieved[Number(id.slice(1))]?.sourceType ?? undefined,
      citationOf: (id) => row.retrieved[Number(id.slice(1))]?.label ?? undefined,
      refusalMarkers: [],
      citationGrammar: GRAMMAR,
    },
    { citations: row.evidence.map((label) => ({ label })) },
  );
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

describe("golden-set-v0 replay — the collection fold measured on the recorded run", () => {
  it("stores every replay requirement in the comparison form the head fixture defines", () => {
    for (const row of ROWS) {
      expect(row.required, row.questionId).toEqual(requiredOf(row).map(GRAMMAR.normalizeLabel));
      for (const entry of row.required) expect(GRAMMAR.normalizeLabel(entry), entry).toBe(entry);
    }
  });

  it("carries the whole run, so the replay below is not vacuous", () => {
    expect(FIXTURE.rows.length).toBe(20);
    expect(ROWS.filter((row) => row.recorded.passed).length).toBe(8);
    expect(ROWS.filter((row) => row.refused && row.expectedBehavior === "answer").length).toBe(6);
    expect(ROWS.every((row) => row.recorded.retrievalRecall === 1)).toBe(true);
  });

  it("moves exactly one row's citation validity — the case the fold was measured on", () => {
    const moved = ROWS.filter(
      (row) => headOutcome(row).citationValidity !== row.recorded.citationValidity,
    );
    expect(moved.map((row) => row.questionId)).toEqual(["gs-v0-004"]);
    expect(moved[0]?.recorded.citationValidity).toBe(0);
    expect(headOutcome(moved[0]!).citationValidity).toBe(1);
  });

  it("scores the head build 9 passed, 11 failed, mean citation validity 0.500", () => {
    const outcomes = ROWS.map(headOutcome);
    expect(outcomes.filter((outcome) => outcome.passed).length).toBe(9);
    expect(mean(outcomes.map((outcome) => outcome.citationValidity))).toBeCloseTo(0.5, 3);
    expect(mean(outcomes.map((outcome) => outcome.sourceTypeRecall))).toBeCloseTo(1, 3);
  });

  it("reports 0.700 address recall where the type-only metric reads 1.000", () => {
    // The recorded run's own fusion never surfaced the required address for these
    // six rows, so a type-only recall of 1.000 over-reports what was retrieved.
    const outcomes = ROWS.map(headOutcome);
    const missed = outcomes
      .filter((outcome) => outcome.citationAddressRecall !== 1)
      .map((outcome) => outcome.questionId);
    expect(missed).toEqual([
      "gs-v0-006",
      "gs-v0-007",
      "gs-v0-008",
      "gs-v0-011",
      "gs-v0-012",
      "gs-v0-016",
    ]);
    expect(mean(outcomes.map((outcome) => outcome.citationAddressRecall!))).toBeCloseTo(0.7, 3);
    expect(mean(outcomes.map((outcome) => outcome.sourceTypeRecall))).toBeCloseTo(1, 3);
  });

  it("flips no other row's pass state, so the fold's blast radius is one case", () => {
    const flips = ROWS.filter((row) => headOutcome(row).passed !== row.recorded.passed);
    expect(flips.map((row) => row.questionId)).toEqual(["gs-v0-004"]);
  });

  it("keeps the case's evidence chain: the requirement and the grounded label are one address", () => {
    const row = ROWS.find((candidate) => candidate.questionId === "gs-v0-004")!;
    expect(row.required).toEqual(["HR. Ibn Majah no. 224"]);
    expect(row.evidence).toContain("HR. Ibn Majah no. 224");
    expect(row.recorded.refused).toBe(false);
  });
});
