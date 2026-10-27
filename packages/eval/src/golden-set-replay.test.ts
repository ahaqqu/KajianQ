/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { GoldenQuestion } from "@app/contracts";
import {
  addressesNamedBy,
  curatedIdentityResolvers,
  normalizeCitationLabel,
} from "@app/kajianq-domain";
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
 * the comparison form of the head fixture below; a row the set has since retired or
 * re-curated keeps the requirement the run was recorded with. The domain-side
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
) as {
  questions: { id: string; requiredCitations: string[]; citationAlternatives?: string[] }[];
};
const HEAD_REQUIRED = new Map(HEAD.questions.map((q) => [q.id, q.requiredCitations]));
const HEAD_ALTERNATIVES = new Map(
  HEAD.questions.flatMap((q) =>
    q.citationAlternatives === undefined ? [] : [[q.id, q.citationAlternatives] as const],
  ),
);

/** The real comparison form, injected exactly as the staging composition root does. */
const GRAMMAR: CitationGrammar = {
  normalizeLabel: normalizeCitationLabel,
  labelsInText: () => [],
  addressesNamedBy,
};

/**
 * The domain's signed relation sets, loaded exactly as the staging harness loads
 * them: the gate reads both relations, and the reported resolver reads the same
 * union for its own address comparison.
 */
const { gating: GATE_IDENTITY, reported: REPORTED_IDENTITY } = curatedIdentityResolvers();

/**
 * The ids the Golden Set has retired since this run was recorded. A recorded row
 * the head set no longer carries keeps the requirement it was scored against; any
 * other missing id is a fixture defect, not history.
 *
 * Kept per file rather than exported from the domain pack: each assertion fails
 * closed on its own, a shared constant would let one edit retire an id in every
 * consumer at once, and a test-only export would enter the product for no runtime
 * caller.
 */
const RETIRED_IDS = new Set(["gs-v0-007"]);

/**
 * Rows whose requirement the head Golden Set re-curated after this run was
 * recorded, with the requirement the run was scored against. A recorded row keeps
 * what the run carried: the replay's claim is about the fold this run measured,
 * and scoring its answer against a requirement the run never saw would re-write
 * history rather than replay it. The recorded value is pinned here, and the head
 * set must have moved off it, so either side changing is a deliberate edit.
 */
const RECURATED_REQUIREMENTS = new Map<string, string[]>([
  // The snapshot stores requirements in the comparison form, so this is the
  // recorded value as the replay reads it, not the fixture's own spelling.
  ["gs-v0-004", ["HR. Ibn Majah no. 224"]],
]);

/** The requirement the head Golden Set carries, or the recorded one for a row the
 * set has re-curated or retired since the run. */
function requiredOf(row: Row): string[] {
  const recurated = RECURATED_REQUIREMENTS.get(row.questionId);
  if (recurated !== undefined) return recurated;
  const required = HEAD_REQUIRED.get(row.questionId);
  if (required !== undefined) return required;
  if (RETIRED_IDS.has(row.questionId)) return row.required;
  throw new Error(`the Golden Set carries no ${row.questionId}`);
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

/** The question as the head instruments read it: the requirement plus any curated
 * alternative set the Golden Set carries at head. Kept apart from `questionOf` so
 * the fold's own replay keeps the requirement shape it was measured with. */
function instrumentQuestionOf(row: Row): GoldenQuestion {
  const question = questionOf(row);
  const alternatives = HEAD_ALTERNATIVES.get(row.questionId);
  return alternatives === undefined
    ? question
    : { ...question, citationAlternatives: [...alternatives] };
}

/** One row scored with the head identity instruments — the gate's resolver and the
 * broader reported resolver — over the same recorded evidence. */
function instrumentOutcome(row: Row): ReturnType<typeof scoreQuestion> {
  return scoreQuestion(
    instrumentQuestionOf(row),
    row.answer,
    eventsOf(row),
    {
      sourceTypeOf: (id) => row.retrieved[Number(id.slice(1))]?.sourceType ?? undefined,
      citationOf: (id) => row.retrieved[Number(id.slice(1))]?.label ?? undefined,
      refusalMarkers: [],
      citationGrammar: GRAMMAR,
      citationIdentity: GATE_IDENTITY,
      reportedCitationIdentity: REPORTED_IDENTITY,
    },
    { citations: row.evidence.map((label) => ({ label })) },
  );
}

describe("golden-set-v0 replay — the collection fold measured on the recorded run", () => {
  it("stores every replay requirement in the comparison form the gate compares", () => {
    for (const row of ROWS) {
      const recurated = RECURATED_REQUIREMENTS.get(row.questionId);
      const required = HEAD_REQUIRED.get(row.questionId);
      if (recurated !== undefined) {
        // A re-curated row keeps the requirement the run carried, and the head
        // set no longer demands it — the other side of the same change. The head
        // side is compared in the gate's comparison form, the form `recurated`
        // is stored in, so the guard fails on any requirement that folds to the
        // recorded one, however the fixture spells it.
        expect(row.required, row.questionId).toEqual(recurated);
        expect(required?.map(GRAMMAR.normalizeLabel), row.questionId).not.toEqual(recurated);
      } else if (required !== undefined) {
        expect(row.required, row.questionId).toEqual(required.map(GRAMMAR.normalizeLabel));
      } else {
        // A retired row's requirement is the recorded one; an id the set neither
        // carries nor has retired is a replay fixture defect.
        expect(
          RETIRED_IDS.has(row.questionId),
          `${row.questionId}: not in the set, not retired`,
        ).toBe(true);
      }
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

describe("the head identity instruments on the recorded run", () => {
  it("flips no recorded passing row", () => {
    // The replay's recorded outcomes are the base build's; every row that passed
    // there must still pass under the head scorers and the signed relation sets.
    // This is the blast radius that matters: a gate that gains a relation must
    // never lose a passing row.
    const recordedPassing = ROWS.filter((row) => row.recorded.passed);
    expect(recordedPassing.length).toBe(8);
    for (const row of recordedPassing) {
      expect(instrumentOutcome(row).passed, row.questionId).toBe(true);
    }
  });

  it("recovers the recorded rows whose evidence cites a signed identity", () => {
    // 003's draft cited the wudu group's canonical 186 for a requirement of 191,
    // 013's cited 5264 (and Tirmidhi 1800) for a requirement of 5265 — both are
    // same-report groups — and 008's cited 1862, 1464 and 3780 for a requirement
    // of 5026, which the map records as the same ruling. The fold's own replay
    // never injected the identity resolver, which is why these did not show
    // there. Every recovered row was recorded as a failure.
    const recovered = ROWS.filter(
      (row) => instrumentOutcome(row).passed && !headOutcome(row).passed,
    );
    expect(recovered.map((row) => row.questionId)).toEqual(["gs-v0-003", "gs-v0-008", "gs-v0-013"]);
    for (const row of recovered) expect(row.recorded.passed).toBe(false);
  });

  it("keeps 012 red on the exact address this run never retrieved, and reports it reached", () => {
    // The pair validates 012's citation (1:3 is the same evidence as 1:1), but this
    // recorded run's fused set never surfaced 1:1, so the exact-address gate keeps
    // the row red. The identity-satisfied figure reads the retrieved 1:3 as the
    // pair's identity — the reported, non-gating residual D4 exists to show.
    const row = ROWS.find((candidate) => candidate.questionId === "gs-v0-012")!;
    const scored = instrumentOutcome(row);
    expect(scored.citationValidity).toBe(1);
    expect(scored.citationAddressRecall).toBe(0);
    expect(scored.passed).toBe(false);
    expect(scored.identitySatisfied).toEqual({
      citationAddressRecall: 1,
      citationValidity: 1,
      passed: true,
    });
  });

  it("does not reach the rows whose recorded evidence carries no signed relation", () => {
    // 006 and 017 REFUSED in this run (their frames carry no label at all), and
    // 016's draft cited no member of the zakat group — the identity instruments
    // cannot reach a citation the run never made. 007 is unreached by both.
    for (const id of ["gs-v0-006", "gs-v0-007", "gs-v0-016", "gs-v0-017"]) {
      const row = ROWS.find((candidate) => candidate.questionId === id)!;
      const scored = instrumentOutcome(row);
      expect(scored.passed, id).toBe(false);
      expect(scored.identitySatisfied?.passed, id).toBe(false);
    }
  });
});
