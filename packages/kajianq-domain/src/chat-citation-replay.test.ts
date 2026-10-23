import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { citationCandidatesIn } from "./chat-citation-normalize";
import { groundingLabelsFor, normalizeCitationLabel } from "./chat-citation-validator";

/**
 * The recorded-run replay fixture's fidelity (`golden-set-v0-replay`), checked
 * against the build that produced it: both the question's requirement and the
 * answer's evidence are re-derived here from the recorded inputs — the answer text,
 * the retrieved chunks' labels, and the chunks that backed a citation sheet.
 *
 * The engine-side replay (`@app/eval`'s `golden-set-replay.test.ts`) scores the
 * fixture with an identity grammar, because the fixture already carries the
 * comparison form. This test is what keeps that honest: a fold that changes what a
 * label folds to fails here rather than silently re-scoring the replay.
 */

const ROOT = new URL("../../../", import.meta.url);
const REPLAY = JSON.parse(
  readFileSync(new URL("packages/kajianq-domain/fixtures/golden-set-v0-replay.json", ROOT), "utf8"),
) as {
  rows: {
    questionId: string;
    required: string[];
    answer: string;
    retrieved: { label: string | null; sourceType: string | null; backed: boolean }[];
    evidence: string[];
  }[];
};
const GOLDEN = JSON.parse(
  readFileSync(new URL("packages/kajianq-domain/fixtures/golden-set-v0.json", ROOT), "utf8"),
) as { questions: { id: string; requiredCitations: string[] }[] };

/**
 * The ids the Golden Set has retired since this run was recorded. A recorded row
 * the head set no longer carries keeps the requirement it was scored against; any
 * other missing id is a fixture defect, not history.
 */
const RETIRED_IDS = new Set(["gs-v0-007"]);

describe("golden-set-v0 replay fixture — the head build's comparison form", () => {
  it("carries every requirement in the comparison form the gate compares", () => {
    for (const row of REPLAY.rows) {
      const question = GOLDEN.questions.find((candidate) => candidate.id === row.questionId);
      if (question === undefined) {
        expect(
          RETIRED_IDS.has(row.questionId),
          `${row.questionId}: not in the Golden Set, not retired`,
        ).toBe(true);
      } else {
        expect(row.required, `${row.questionId}: the required citation`).toEqual(
          question.requiredCitations.map(normalizeCitationLabel),
        );
      }
      // A retired row's requirement is its recorded one; both forms are checked in
      // the gate's own comparison form so the replay cannot re-score a re-spelling.
      for (const entry of row.required) {
        expect(normalizeCitationLabel(entry), `${row.questionId}: ${entry}`).toBe(entry);
      }
    }
  });

  it("derives each row's evidence the way the frame derives it — the answer's accepted spans", () => {
    for (const row of REPLAY.rows) {
      const known = new Set(
        row.retrieved
          .filter((chunk) => chunk.backed && chunk.label !== null)
          .map((chunk) => normalizeCitationLabel(chunk.label!)),
      );
      const evidence = citationCandidatesIn(row.answer).filter(
        (span) => groundingLabelsFor(span, known) !== null,
      );
      expect(evidence, `${row.questionId}: the frame's labels`).toEqual(row.evidence);
    }
  });
});
