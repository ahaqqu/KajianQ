import { describe, expect, it } from "vite-plus/test";
import {
  buildPreregistrationArtifact,
  DEFAULT_SAMPLE_TARGETS,
  labelsTemplateRows,
  ownerSpotCheckRows,
  sampleSeed,
  selectBlindSample,
  seededOrder,
  SAMPLE_PER_STRATUM,
} from "./sanadset-sample";
import type { PairCandidates, PairStratum, StudyPair } from "./sanadset-pairs";

/**
 * Test intent, named before the assertions:
 * - trap: the sample must be reproducible from the dataset hash alone, so a second run
 *   of the study draws the same 300 pairs — otherwise "pre-registered" means nothing;
 * - trap: a stratum with too few candidates must be reported as short, never padded with
 *   invented or duplicated pairs, and its unused quota must move to a stratum that has
 *   candidates;
 * - trap: blinding lives in the presentation files. The labels sheet and the owner's
 *   spot-check sheet must carry no stratum, no lexical score and no label, or the
 *   labeller reads the answer off the row.
 */

const STRATA = Object.keys(DEFAULT_SAMPLE_TARGETS) as PairStratum[];

function pair(stratum: PairStratum, index: number): StudyPair {
  // A per-stratum offset keeps the pair text unique across strata, the way a real
  // narrator pair can never equal a matn pair.
  const offset = STRATA.indexOf(stratum) * 1_000;
  return {
    kind: stratum.startsWith("narrator_") ? "narrator" : "matn",
    stratum,
    a: `name-a-${offset + index}`,
    b: `name-b-${offset + index}`,
    ref: { rowA: index, rowB: index + 1, score: 0.7 },
  };
}

function candidates(
  perStratum: number,
  overrides: Partial<Record<PairStratum, number>> = {},
): PairCandidates {
  const pool: PairCandidates = new Map();
  for (const stratum of Object.keys(DEFAULT_SAMPLE_TARGETS) as PairStratum[]) {
    const count = overrides[stratum] ?? perStratum;
    pool.set(
      stratum,
      Array.from({ length: count }, (_, index) => pair(stratum, index)),
    );
  }
  return pool;
}

describe("the seed", () => {
  it("is derived from the dataset hash, not the clock", () => {
    expect(sampleSeed("abc")).toBe(sampleSeed("abc"));
    expect(sampleSeed("abc")).not.toBe(sampleSeed("abd"));
  });
});

describe("seededOrder", () => {
  it("is deterministic and a permutation of its input", () => {
    const input = Array.from({ length: 20 }, (_, index) => pair("matn_exact", index));
    const first = seededOrder(input, 7).map((entry) => entry.a);
    const second = seededOrder(input, 7).map((entry) => entry.a);
    expect(second).toEqual(first);
    expect([...first].sort()).toEqual(input.map((entry) => entry.a).sort());
  });

  it("changes with the seed", () => {
    const input = Array.from({ length: 50 }, (_, index) => pair("matn_exact", index));
    expect(seededOrder(input, 1).map((entry) => entry.a)).not.toEqual(
      seededOrder(input, 2).map((entry) => entry.a),
    );
  });
});

describe("selectBlindSample", () => {
  it("draws the full quota when every stratum can fill it", () => {
    const selection = selectBlindSample({ candidates: candidates(60), seed: 11 });
    expect(selection.requested).toBe(300);
    expect(selection.selected).toBe(300);
    expect(selection.shortfall).toBe(0);
    expect(selection.composition.every((entry) => entry.selected === SAMPLE_PER_STRATUM)).toBe(
      true,
    );
    expect(new Set(selection.pairs.map((entry) => entry.pairId)).size).toBe(300);
    expect(selection.pairs.filter((entry) => entry.kind === "narrator")).toHaveLength(150);
    expect(selection.pairs.filter((entry) => entry.kind === "matn")).toHaveLength(150);
  });

  it("is reproducible for the same seed and candidates", () => {
    const first = selectBlindSample({ candidates: candidates(60), seed: 42 });
    const second = selectBlindSample({ candidates: candidates(60), seed: 42 });
    expect(second.pairs.map((entry) => `${entry.pairId}:${entry.a}`)).toEqual(
      first.pairs.map((entry) => `${entry.pairId}:${entry.a}`),
    );
  });

  it("moves a short stratum's quota to a stratum that has candidates", () => {
    const selection = selectBlindSample({ candidates: candidates(80, { matn_exact: 5 }), seed: 3 });
    const composition = new Map(
      selection.composition.map((entry) => [entry.stratum, entry.selected]),
    );
    expect(composition.get("matn_exact")).toBe(5);
    expect(selection.selected).toBe(300);
    expect(selection.shortfall).toBe(0);
    expect(selection.pairs.filter((entry) => entry.kind === "matn")).toHaveLength(150);
    expect(composition.get("matn_near_duplicate") ?? 0).toBeGreaterThan(SAMPLE_PER_STRATUM);
  });

  it("cannot exceed a kind's budget even when it must leave a quota unfilled", () => {
    const selection = selectBlindSample({ candidates: candidates(60, { matn_exact: 5 }), seed: 3 });
    const composition = new Map(
      selection.composition.map((entry) => [entry.stratum, entry.selected]),
    );
    expect(composition.get("matn_exact")).toBe(5);
    // 5 + 60 + 60 = 125 matn candidates: the matn budget cannot be filled, and the
    // narrator budget is not spent on matn pairs to compensate.
    expect(selection.pairs.filter((entry) => entry.kind === "matn")).toHaveLength(125);
    expect(selection.pairs.filter((entry) => entry.kind === "narrator")).toHaveLength(150);
    expect(selection.selected).toBe(275);
    expect(selection.shortfall).toBe(25);
  });

  it("reports a shortfall instead of inventing pairs when the population is too small", () => {
    const selection = selectBlindSample({ candidates: candidates(2), seed: 5 });
    expect(selection.selected).toBe(12);
    expect(selection.shortfall).toBe(288);
    expect(
      selection.composition.every((entry) => entry.candidates === 2 && entry.selected === 2),
    ).toBe(true);
  });

  it("never draws a pair whose two sides are the same string", () => {
    const pool = candidates(60);
    pool.set("matn_exact", [
      {
        kind: "matn",
        stratum: "matn_exact",
        a: "same text",
        b: "same text",
        ref: { rowA: 0, rowB: 1, score: 1 },
      },
      ...(pool.get("matn_exact") ?? []),
    ]);
    const selection = selectBlindSample({ candidates: pool, seed: 7 });
    expect(selection.pairs.every((entry) => entry.a !== entry.b)).toBe(true);
    // The identical pair is not merely skipped: it never counts as an eligible candidate.
    expect(selection.composition.find((entry) => entry.stratum === "matn_exact")?.candidates).toBe(
      60,
    );
  });

  it("never selects the same pair twice", () => {
    const selection = selectBlindSample({ candidates: candidates(60), seed: 9 });
    const seen = new Set(selection.pairs.map((entry) => `${entry.a}\u0000${entry.b}`));
    expect(seen.size).toBe(selection.pairs.length);
  });
});

describe("the presentation files", () => {
  const selection = selectBlindSample({ candidates: candidates(60), seed: 21 });

  it("writes a labels template with one empty label per pair and no stratum", () => {
    const rows = labelsTemplateRows(selection.pairs);
    expect(rows[0]).toEqual(["pair_id", "kind", "a", "b", "label", "notes"]);
    expect(rows).toHaveLength(301);
    expect(rows.slice(1).every((row) => row[4] === "" && row[5] === "")).toBe(true);
    const text = rows.flat().join("\u0000");
    for (const stratum of Object.keys(DEFAULT_SAMPLE_TARGETS)) expect(text).not.toContain(stratum);
  });

  it("gives the owner a blind subset that is a subset of the pre-registered pairs", () => {
    const rows = ownerSpotCheckRows(selection.pairs, selection.seed);
    expect(rows).toHaveLength(51);
    const registered = new Set(selection.pairs.map((entry) => entry.pairId));
    for (const row of rows.slice(1)) expect(registered.has(row[0] as string)).toBe(true);
    expect(new Set(rows.slice(1).map((row) => row[0])).size).toBe(50);
    const text = rows.flat().join("\u0000");
    for (const stratum of Object.keys(DEFAULT_SAMPLE_TARGETS)) expect(text).not.toContain(stratum);
    expect(text).not.toContain("similarity");
  });

  it("keeps the scores and strata in the analyst-side preregistration only", () => {
    const artifact = buildPreregistrationArtifact({
      selection,
      sourceSha256: "deadbeef",
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(artifact.pairs).toHaveLength(300);
    expect(artifact.pairs[0]).toHaveProperty("stratum");
    expect(artifact.pairs[0]).toHaveProperty("ref");
    expect(artifact.pairs[0]).not.toHaveProperty("label");
    expect(artifact.labellingLimitation).toContain("50");
    expect(artifact.sourceSha256).toBe("deadbeef");
  });
});
