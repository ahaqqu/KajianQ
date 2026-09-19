/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { citationValidity } from "./scorers";
import type { TraceEventLike } from "./harness-types";

/**
 * Deterministic replay of the historical `gs-v0-015` rows (thermo-review A1,
 * PR #188). The PR claims that switching `citationValidity` to the
 * frame-first precedence regresses nothing across the 31 historical staging
 * rows — a trust-weight claim for an eval gate that decides pass/fail on
 * religious-content quality, so the claim is pinned here instead of trusted
 * to an unrecorded local run.
 *
 * The fixture (`packages/kajianq-domain/fixtures/gs-v0-015-replay.json`)
 * snapshots the 31 historical `eval_results` rows for `gs-v0-015` from the
 * staging store, carrying exactly the fields the scorer reads: the persisted
 * answer text, the trace review event's `grounded` labels (`null` where an
 * older trace predates the field — the fall-through signal), whether a
 * `refusal` event exists, and the curation label in force at each run (the
 * fixture required `QS. 1:1` until the 2026-09-12 re-curation switched it to
 * `QS. 1:2` mid-history — replaying every row against today's label would
 * misreport one row as a scorer flip when it is a fixture edit, not a
 * scorer change).
 *
 * The citation grammar is FAKED here with the same shape `scorers.test.ts`
 * uses: the engine package must not import the domain pack's grammar
 * (boundary), and the real functions' observable behavior on these labels —
 * canonicalizing `Q.S.`/`QS` to `QS.`, collapsing whitespace, stripping
 * markdown emphasis — is exactly what the fake mirrors.
 */

const ROOT = new URL("../../../", import.meta.url);
const FIXTURE = JSON.parse(
  readFileSync(new URL("packages/kajianq-domain/fixtures/gs-v0-015-replay.json", ROOT), "utf8"),
) as {
  id: string;
  refusalMarkers: string[];
  rows: {
    at: string;
    required: string[];
    text: string;
    /** The trace review event's `grounded` labels; null = the field is absent. */
    grounded: string[] | null;
    refusalEvent: boolean;
    recorded: { passed: boolean; citationValidity: number; retrievalRecall: number };
  }[];
};

const ROWS = FIXTURE.rows;

/**
 * The old scorer's semantics, verbatim from the pre-#188 harness
 * (`requiredCitations.filter((c) => answerText.includes(c))` on the
 * transport's answer text) — the check whose behavior the change preserves.
 */
const oldCitationCount = (required: readonly string[], text: string): number =>
  required.filter((c) => text.includes(c)).length;

/**
 * The domain's citation grammar, mirrored (not imported — the engine stays
 * domain-agnostic): normalize a label the way `normalizeCitationLabel` does,
 * and extract the citation-shaped spans the way `citationCandidatesIn` does.
 */
const canon = (label: string): string =>
  label
    .replace(/[*_`]+/g, "")
    .replace(/\bQ\.?S\.?(?=\s)/g, "QS.")
    .replace(/\s+/g, " ")
    .trim();
const grammar = {
  normalizeLabel: canon,
  labelsInText: (text: string) =>
    [...text.matchAll(/Q\.?S(?:\.|\s)\s*[^\s:,[\]()]+\s*:\s*\d+/gi)].map((m) => canon(m[0]!)),
};

/** The row's evidence under the new precedence: the grounded list, or the text. */
function eventsOf(row: (typeof ROWS)[number]): TraceEventLike[] | undefined {
  if (row.grounded === null) return undefined; // an older trace: fall through to the text
  return [{ kind: "review", stage: "reviewer", detail: { verdict: "{}", grounded: row.grounded } }];
}

/** The new scorer's citation count for one historical row. */
function newCitationCount(row: (typeof ROWS)[number]): number {
  const events = eventsOf(row);
  return (
    citationValidity(row.required, row.text, {
      ...(events !== undefined ? { events } : {}),
      grammar,
    }) * row.required.length
  );
}

describe("gs-v0-015 historical replay (thermo-review A1, PR #188)", () => {
  it("carries all 31 historical rows (so the replay below is not vacuous)", () => {
    expect(ROWS.length).toBe(31);
    expect(ROWS.every((row) => row.required.length === 1)).toBe(true);
    // The snapshot's recorded outcomes are the replay's ground truth: 20
    // passed the citation check, 11 failed it, across 2026-09-12 … 09-19.
    expect(ROWS.filter((row) => row.recorded.citationValidity === 1).length).toBe(20);
    expect(ROWS.filter((row) => row.recorded.citationValidity === 0).length).toBe(11);
  });

  it("reproduces the old scorer's recorded citationValidity from the snapshot", () => {
    // Parity with the historical runs: for every row, the old
    // `String.includes` scorer over the persisted answer text — with the
    // curation label the run itself used — gives exactly the recorded
    // citationValidity. If this drifts, the snapshot no longer describes the
    // runs the claim was about, and the invariants below are moot.
    for (const row of ROWS) {
      const replayed = oldCitationCount(row.required, row.text) / row.required.length;
      expect(replayed, `${row.at}: old-semantics replay diverges from the recorded outcome`).toBe(
        row.recorded.citationValidity,
      );
    }
  });

  it("gives 0 regressions and 0 new passes under the new frame-first scorer", () => {
    // The claim the PR makes, now reproducible: scoring every historical row
    // with the NEW evidence precedence (grounded list, else the text through
    // the grammar) flips no recorded outcome's pass state. Refusal rows stay
    // failed: the refusal signal (trace event or marker text) is unchanged
    // by the citation-scoring fix.
    const regressions: string[] = [];
    const newPasses: string[] = [];
    for (const row of ROWS) {
      const count = newCitationCount(row);
      const newPassed =
        count === row.required.length &&
        row.recorded.retrievalRecall === 1 &&
        !row.refusalEvent &&
        !FIXTURE.refusalMarkers.some((m) => row.text.includes(m));
      if (row.recorded.passed && !newPassed) regressions.push(row.at);
      if (!row.recorded.passed && newPassed) newPasses.push(row.at);
    }
    expect(regressions, "rows the new scorer would newly fail").toEqual([]);
    expect(newPasses, "rows the new scorer would newly pass").toEqual([]);
  });

  it("keeps byte-exact parity with the old includes semantics on the text-only path", () => {
    // With no frame and no trace events, the new scorer without a grammar IS
    // the old scorer — asserted on every row's real answer text, not on a
    // synthetic example.
    for (const row of ROWS) {
      expect(citationValidity(row.required, row.text)).toBe(
        oldCitationCount(row.required, row.text) / row.required.length,
      );
    }
  });

  it("scores the spelling-variant cases the fix targets (and the old check missed)", () => {
    // No historical answer carries a marker variant (the gate's own grammar
    // grounded them verbatim — the variants never reached the store), so the
    // variant cases are replayed as the fix's minimal inputs in the shape of
    // the recorded passing run (row 29, run `c9547d00`): the same answer text
    // with the spellings the citation gate itself accepts, where the raw
    // substring check scores 0.
    const passingText = ROWS[29]!.text;
    expect(ROWS[29]!.recorded.citationValidity).toBe(1);
    expect(oldCitationCount(["QS. 1:2"], passingText)).toBe(1); // the verbatim form
    for (const variant of ["Q.S. 1:2", "QS 1:2", "QS.  1:2"]) {
      const variantText = passingText.replace("QS. 1:2", variant);
      expect(
        oldCitationCount(["QS. 1:2"], variantText),
        `${variant}: the old check must miss it (the defect being fixed)`,
      ).toBe(0);
      expect(
        newCitationCount({ ...ROWS[29]!, text: variantText, grounded: null }),
        `${variant}: the new text path must score it`,
      ).toBe(1);
    }
  });

  it("holds the invariant: a label absent from a non-empty frame never scores", () => {
    // The ADR-0040 invariant the scorer relies on, asserted over every
    // historical grounded list: feeding each row's grounded evidence as a
    // frame keeps the required label's score identical to scoring it as the
    // trace's grounded list.
    for (const row of ROWS) {
      if (row.grounded === null) continue; // an absent field is not a frame
      const frame = { citations: row.grounded.map((label) => ({ label })) };
      const events = eventsOf(row)!;
      const viaFrame = citationValidity(row.required, row.text, { frame, grammar });
      const viaEvents = citationValidity(row.required, row.text, {
        ...(events !== undefined ? { events } : {}),
        grammar,
      });
      expect(viaFrame, `${row.at}: frame and grounded scoring must agree`).toBe(viaEvents);
    }
    // And the direction that cannot manufacture a pass — a frame that grounds
    // nothing never lets the text's own marker through:
    const frame = { citations: [{ label: "QS. 2:255" }] };
    expect(
      citationValidity(["QS. 1:2"], "the text names QS. 1:2 plainly", { frame, grammar }),
    ).toBe(0);
  });
});
