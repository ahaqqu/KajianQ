/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { citationValidity } from "./scorers";
import type { TraceEventLike } from "./harness-types";

/**
 * Deterministic replay of the historical `gs-v0-015` rows. The fixture
 * (`packages/kajianq-domain/fixtures/gs-v0-015-replay.json`) snapshots those
 * staging `eval_results` rows with exactly the fields the scorer reads: the
 * answer text, the trace review event's `grounded` labels (`null` where the
 * field is absent — the fall-through signal), whether a `refusal` event exists,
 * whether the `citations` frame was empty (an EMPTY frame is authoritative and
 * grounds nothing), and the curation label each run used — a row must be
 * replayed against its own label, or a fixture edit misreports as a scorer flip.
 * The citation grammar is FAKED (the engine must not import the domain pack).
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
     * Whether the `citations` frame the run's transport carried was EMPTY — the
     * authoritative state that grounds nothing, so on such a row this field
     * decides the score. `false` covers a non-empty frame and a run that
     * predates the frame, where the scorer falls through to `grounded`.
     */
    frameEmpty: boolean;
    recorded: { passed: boolean; citationValidity: number; retrievalRecall: number };
  }[];
};

const ROWS = FIXTURE.rows;

/** The verbatim-substring citation count the recorded outcomes came from, kept for parity. */
const oldCitationCount = (required: readonly string[], text: string): number =>
  required.filter((c) => text.includes(c)).length;

/** The domain's citation grammar, mirrored rather than imported (the engine
 * stays domain-agnostic). */
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
  // The rows carry no list-valued citation form, so this mirror declares identity.
  addressesNamedBy: (label: string): readonly string[] => [label],
};

/** The row's evidence under the scorer's precedence: the grounded list, or the text. */
function eventsOf(row: (typeof ROWS)[number]): TraceEventLike[] | undefined {
  if (row.grounded === null) return undefined; // no `grounded` field: fall through to the text
  return [{ kind: "review", stage: "reviewer", detail: { verdict: "{}", grounded: row.grounded } }];
}

/**
 * The `citations` frame the deployed scorer read on that run, when the snapshot
 * knows it was EMPTY. A non-empty frame is not reconstructed: its labels are the
 * same intersection the trace's `grounded` list records.
 */
function frameOf(row: (typeof ROWS)[number]): { citations: { label: string }[] } | undefined {
  return row.frameEmpty ? { citations: [] } : undefined;
}

/** The scorer's citation count for one historical row. */
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

/** The pass state the current scorer computes for one row — the fixture's own
 * model of the run (`gs-v0-015` is an `answer` question, so a refusal fails). */
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
    expect(ROWS.filter((row) => row.recorded.citationValidity === 1).length).toBe(20);
    expect(ROWS.filter((row) => row.recorded.citationValidity === 0).length).toBe(11);
  });

  it("reproduces the old scorer's recorded citationValidity from the snapshot", () => {
    // Parity: the verbatim-substring count over the persisted text, with the label
    // the run used, must give the recorded citationValidity.
    for (const row of ROWS) {
      const replayed = oldCitationCount(row.required, row.text) / row.required.length;
      expect(replayed, `${row.at}: old-semantics replay diverges from the recorded outcome`).toBe(
        row.recorded.citationValidity,
      );
    }
  });

  it("pins the fixture's frame state to the snapshot's own sources (no inferred frame)", () => {
    // `frameEmpty` is data: a refusal row, or an empty `grounded` list, shipped an empty frame.
    for (const row of ROWS) {
      expect(row.frameEmpty, `${row.at}: frame state diverges from its sources`).toBe(
        row.refusalEvent || (row.grounded !== null && row.grounded.length === 0),
      );
    }
  });

  it("scores the four historical refusal rows 0 through the frame the deployed scorer reads", () => {
    // On a refusal row the `grounded` list can still carry the required label
    // while the EMPTY frame grounds nothing.
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
    // Scoring every row with the current evidence precedence — the frame when it
    // was empty and authoritative, else the grounded list, else the text through
    // the grammar — flips no recorded outcome's pass state.
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
    // The hybrid shape — a refusal over a PARTIAL answer that quotes a grounded
    // verse — is constructed here, not added to the fixture: the text is the
    // snapshot's own passing answer plus the canonical refusal sentence.
    const passing = ROWS[29]!;
    expect(passing.recorded.citationValidity).toBe(1);
    expect(passing.grounded).toContain("QS. 1:2");
    const hybrid = {
      at: "hybrid (QA trace fff2a012)",
      required: ["QS. 1:2"],
      text: `${passing.text} ${FIXTURE.refusalMarkers[0]}`,
      grounded: ["QS. 1:2"],
      refusalEvent: true,
      frameEmpty: false, // the frame keeps the label the text grounds
      recorded: { passed: false, citationValidity: 0, retrievalRecall: 1 },
    };
    // An empty frame on this row scores 0 ...
    expect(newCitationCount({ ...hybrid, frameEmpty: true })).toBe(0);
    // ... the frame that carries the grounded label scores 1 ...
    expect(newCitationCount(hybrid)).toBe(1);
    // ... and the question still FAILS: `gs-v0-015` is an `answer` question.
    expect(newPassed(hybrid)).toBe(false);
  });

  it("keeps byte-exact parity with the old includes semantics on the text-only path", () => {
    // Without a frame or events the scorer with no grammar reduces to that same
    // verbatim-substring count — asserted on every row's real answer text.
    for (const row of ROWS) {
      expect(citationValidity(row.required, row.text)).toBe(
        oldCitationCount(row.required, row.text) / row.required.length,
      );
    }
  });

  it("scores the spelling-variant cases the fix targets (and the old check missed)", () => {
    // No historical answer carries a marker variant, so the variant cases use a
    // recorded passing answer's text with the spellings the gate accepts.
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
    // The ADR-0040 invariant, over every historical grounded list: a row's
    // grounded evidence scored as a frame equals scoring it as trace labels.
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
    // And a frame that grounds nothing never lets the text's own marker through:
    const frame = { citations: [{ label: "QS. 2:255" }] };
    expect(
      citationValidity(["QS. 1:2"], "the text names QS. 1:2 plainly", { frame, grammar }),
    ).toBe(0);
  });
});
