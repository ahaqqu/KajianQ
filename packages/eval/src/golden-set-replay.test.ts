/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { GoldenQuestion } from "@app/contracts";
import { scoreQuestion } from "./harness";
import type { CitationGrammar, TraceEventLike } from "./harness-types";

/**
 * Deterministic replay of the run the collection-name spelling fold was measured
 * on (`packages/kajianq-domain/fixtures/golden-set-v0-replay.json` — the snapshot's
 * own `$comment` states what it carries and what a replay can and cannot show).
 *
 * The grammar here is the **identity**, and that is the point: every label the
 * fixture holds is already in the head build's comparison form, snapshotted with the
 * gate that produced it. The domain-side `chat-citation-replay` test re-derives both
 * sides from the recorded answer texts and retrieved chunks, so this file cannot
 * score a vocabulary of its own — and the engine stays domain-agnostic. With a frame
 * on every row, the text path is unreachable, which is why `labelsInText` is empty.
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

const GRAMMAR: CitationGrammar = {
  normalizeLabel: (label) => label,
  labelsInText: () => [],
  addressesNamedBy: (label) => [label],
};

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
    requiredCitations: row.required,
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
      refusalMarkers: [],
      citationGrammar: GRAMMAR,
    },
    { citations: row.evidence.map((label) => ({ label })) },
  );
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

describe("golden-set-v0 replay — the collection fold measured on the recorded run", () => {
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
    expect(mean(outcomes.map((outcome) => outcome.retrievalRecall))).toBeCloseTo(1, 3);
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
