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
 * `refusal` event exists, whether the transport's `citations` frame was empty
 * (an EMPTY frame is authoritative and grounds nothing — thermo-review A3 of
 * #437), and the curation label in force at each run (the
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
    /**
     * Whether the `citations` frame the run's transport carried was EMPTY. An
     * empty frame is authoritative and grounds nothing (`scorers.ts`), so on a
     * row where the retired derivation emptied any refusal's frame this field
     * is what decides the score — the `grounded` list cannot stand in for it
     * (thermo-review A3 of #437). `false` covers both a non-empty frame and a
     * run that predates the frame, where the scorer falls through to `grounded`
     * and then the text.
     */
    frameEmpty: boolean;
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
  // The historical rows carry no list-valued citation form, so this mirror
  // declares the required member as identity rather than omitting it (review
  // R1: omission is now a loud `CitationGrammarError`, never a silent
  // string-only fallback).
  addressesNamedBy: (label: string): readonly string[] => [label],
};

/** The row's evidence under the new precedence: the grounded list, or the text. */
function eventsOf(row: (typeof ROWS)[number]): TraceEventLike[] | undefined {
  if (row.grounded === null) return undefined; // an older trace: fall through to the text
  return [{ kind: "review", stage: "reviewer", detail: { verdict: "{}", grounded: row.grounded } }];
}

/**
 * The `citations` frame the deployed scorer read on that run, when the snapshot
 * knows it was EMPTY — the authoritative state that grounds nothing. A
 * non-empty frame is not reconstructed here: its labels are the same
 * cited-and-grounded intersection the trace's `grounded` list records, so
 * `undefined` (fall through to `grounded`, then the text) is verdict-equivalent
 * and the one state that changes a score is the empty frame (A3 of #437).
 */
function frameOf(row: (typeof ROWS)[number]): { citations: { label: string }[] } | undefined {
  return row.frameEmpty ? { citations: [] } : undefined;
}

/** The new scorer's citation count for one historical row. */
function newCitationCount(row: (typeof ROWS)[number]): number {
  const events = eventsOf(row);
  const frame = frameOf(row);
  return (
    citationValidity(row.required, row.text, {
      ...(frame !== undefined ? { frame } : {}),
      ...(events !== undefined ? { events } : {}),
      grammar,
    }) * row.required.length
  );
}

/**
 * The pass state the new scorer computes for one row — the fixture's own model
 * of the run (gs-v0-015 is an `answer` question, so a recorded refusal fails it).
 */
function newPassed(row: (typeof ROWS)[number]): boolean {
  return (
    newCitationCount(row) === row.required.length &&
    row.recorded.retrievalRecall === 1 &&
    !row.refusalEvent &&
    !FIXTURE.refusalMarkers.some((m) => row.text.includes(m))
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

  it("pins the fixture's frame state to the snapshot's own sources (no inferred frame)", () => {
    // `frameEmpty` is data, not a convenience: a refusal row's frame was emptied
    // by the derivation this change retires, and a row whose `grounded` list is
    // empty shipped an empty frame too (an empty frame grounds nothing). Every
    // other row defers to the trace's `grounded` labels. If this drifts, the
    // replay stops describing the runs its claim is about (A3 of #437).
    for (const row of ROWS) {
      expect(row.frameEmpty, `${row.at}: frame state diverges from its sources`).toBe(
        row.refusalEvent || (row.grounded !== null && row.grounded.length === 0),
      );
    }
  });

  it("scores the four historical refusal rows 0 through the frame the deployed scorer reads", () => {
    // The divergence A3 caught, modeled instead of masked: on two of these rows
    // (`15:18`, `08:07`) the trace's `grounded` list still carries the required
    // `QS. 1:2`, while the EMPTY frame the transport actually carried grounds
    // nothing — so scoring the grounded list gives 1 where the deployed scorer
    // gives 0 for the same row. All four keep the 0 they were recorded with: the
    // pure-refusal control on real staging data, not on a synthetic string.
    const refusals = ROWS.filter((row) => row.refusalEvent);
    expect(refusals.length).toBe(4);
    for (const row of refusals) {
      expect(row.frameEmpty, `${row.at}: a refusal row's frame was empty`).toBe(true);
      expect(newCitationCount(row), `${row.at}: the frame path`).toBe(0);
      expect(row.recorded.citationValidity, `${row.at}: the recorded outcome`).toBe(0);
    }
    const diverging = refusals.filter((row) =>
      row.grounded?.some((label) => label.includes(row.required[0]!)),
    );
    expect(diverging.map((row) => row.at)).toEqual([
      "2026-09-12T15:18:19.781Z",
      "2026-09-19T08:07:19.161Z",
    ]);
    for (const row of diverging) {
      const events = eventsOf(row);
      expect(
        citationValidity(row.required, row.text, {
          ...(events !== undefined ? { events } : {}),
          grammar,
        }),
        `${row.at}: the bare grounded list would score this row 1`,
      ).toBe(1);
    }
  });

  it("gives 0 regressions and 0 new passes under the new frame-first scorer", () => {
    // The claim the PR makes, now reproducible: scoring every historical row
    // with the NEW evidence precedence (the frame the transport carried when it
    // was empty and authoritative; otherwise the grounded list, else the text
    // through the grammar) flips no recorded outcome's pass state. Refusal rows
    // stay failed: the refusal signal (trace event or marker text) is unchanged
    // by the citation-scoring fix.
    const regressions: string[] = [];
    const newPasses: string[] = [];
    for (const row of ROWS) {
      const passed = newPassed(row);
      if (row.recorded.passed && !passed) regressions.push(row.at);
      if (!row.recorded.passed && passed) newPasses.push(row.at);
    }
    expect(regressions, "rows the new scorer would newly fail").toEqual([]);
    expect(newPasses, "rows the new scorer would newly pass").toEqual([]);
  });

  it("moves the citation metric on the hybrid shape and still fails the question (#436)", () => {
    // The shape this change exists for — and the shape the 31-row snapshot has
    // none of: a refusal recorded over a PARTIAL answer that quotes a grounded
    // verse (the QA trace `fff2a012`). It is constructed here, not added to the
    // fixture, because the fixture is a historical staging snapshot; its text is
    // the snapshot's own passing answer plus the canonical refusal sentence.
    const passing = ROWS[29]!;
    expect(passing.recorded.citationValidity).toBe(1);
    expect(passing.grounded).toContain("QS. 1:2");
    const hybrid = {
      at: "hybrid (QA trace fff2a012)",
      required: ["QS. 1:2"],
      text: `${passing.text} ${FIXTURE.refusalMarkers[0]}`,
      grounded: ["QS. 1:2"],
      refusalEvent: true,
      frameEmpty: false, // the head derivation keeps the label the text grounds
      recorded: { passed: false, citationValidity: 0, retrievalRecall: 1 },
    };
    // The retired derivation emptied any refusal's frame: the same row scores 0.
    expect(newCitationCount({ ...hybrid, frameEmpty: true })).toBe(0);
    // The head derivation carries the grounded label: the metric moves to 1 ...
    expect(newCitationCount(hybrid)).toBe(1);
    // ... and the question still FAILS, because gs-v0-015 is an `answer` question
    // and this row records a refusal. Gate-affecting, not gate-masking.
    expect(newPassed(hybrid)).toBe(false);
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
