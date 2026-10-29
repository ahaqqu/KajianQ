import { describe, expect, it } from "vite-plus/test";
import { createCallBudget, ModelCallCeilingError } from "./sanadset-budget";
import { lshBandKeys, minhashSignature } from "./sanadset-blocking";
import { runMatnCascade } from "./sanadset-cascade";
import type { PreparedRow } from "./sanadset-prepare";

/**
 * Test intent, named before the assertions:
 * - trap: the two thresholds are pre-registered, so the suite asserts the *boundary* in
 *   both directions (exactly 0.90 joins, just under it is band; exactly 0.60 is band,
 *   just under it is no-match) rather than a comfortable interior value;
 * - trap: an ambiguous best match must be quarantined *before* the model is asked, or an
 *   arbitrary tie-break could force-merge two groups;
 * - trap: a spent ceiling must leave band rows unresolved, never "different" — silence
 *   must not become a decision;
 * - trap: an adjudicator without a budget must throw, so no run reaches a paid call
 *   without a reservation.
 *
 * Trigram sets are built by construction so each pair's Jaccard score is exact:
 * |A| = 10, |B| = 9, |A ∩ B| = 9 gives 9/10 = 0.90; |A| = |B| = 8 with 6 shared gives
 * 6/10 = 0.60; |A| = 10, |B| = 8 with 6 shared gives 6/12 = 0.50.
 */

function prepared(
  rowIndex: number,
  rawMatn: string,
  trigrams: string[],
  normalized?: string,
): PreparedRow {
  const signature = minhashSignature(trigrams);
  return {
    rowIndex,
    book: "صحيح البخاري",
    hadithNumber: String(rowIndex),
    rawMatn,
    normalizedMatn: normalized ?? `norm-${rowIndex}`,
    trigrams,
    signature,
    bandKeys: lshBandKeys(signature),
    chain: ["مالك"],
    rawChain: ["مالك"],
  };
}

const shared = (size: number): string[] => Array.from({ length: size }, (_, index) => `g${index}`);
const window = (start: number, size: number): string[] =>
  Array.from({ length: size }, (_, index) => `g${start + index}`);
const unique = (name: string, size: number): string[] =>
  Array.from({ length: size }, (_, index) => `${name}${index}`);

describe("the cascade stages", () => {
  it("joins an identical raw matn at the exact stage without scoring", async () => {
    const result = await runMatnCascade({
      rows: [prepared(0, "same", ["a", "b", "c"]), prepared(1, "same", ["a", "b", "c"])],
    });
    expect(result.decisions[1]?.kind).toBe("exact");
    expect(result.decisions[1]?.matchedRowIndex).toBe(0);
    expect(result.counts.exact).toBe(1);
    expect(result.groups).toHaveLength(1);
  });

  it("joins a folding-equivalent matn at the folded stage", async () => {
    const rows = [
      prepared(0, "raw-a", ["a", "b", "c"], "same-norm"),
      prepared(1, "raw-b", ["x", "y"], "same-norm"),
    ];
    const result = await runMatnCascade({ rows });
    expect(result.decisions[1]?.kind).toBe("folded");
    expect(result.counts.folded).toBe(1);
  });

  it("joins at the auto threshold of exactly 0.90", async () => {
    const result = await runMatnCascade({
      rows: [prepared(0, "a", shared(10)), prepared(1, "b", shared(9))],
    });
    expect(result.decisions[1]?.score).toBeCloseTo(0.9, 10);
    expect(result.decisions[1]?.kind).toBe("trigram");
    expect(result.groups).toHaveLength(1);
  });

  it("leaves an 0.80 pair in the band and starts a new group when no adjudicator exists", async () => {
    const result = await runMatnCascade({
      rows: [prepared(0, "a", shared(10)), prepared(1, "b", shared(8))],
    });
    expect(result.decisions[1]?.score).toBeCloseTo(0.8, 10);
    expect(result.decisions[1]?.kind).toBe("band-unresolved");
    expect(result.groups).toHaveLength(2);
    expect(result.model.status).toBe("not-run");
  });

  it("treats exactly 0.60 as band and 0.50 as no match", async () => {
    const atBand = await runMatnCascade({
      rows: [prepared(0, "a", shared(8)), prepared(1, "b", [...shared(6), ...unique("p", 2)])],
    });
    expect(atBand.decisions[1]?.score).toBeCloseTo(0.6, 10);
    expect(atBand.decisions[1]?.kind).toBe("band-unresolved");

    const belowBand = await runMatnCascade({
      rows: [prepared(0, "a", shared(10)), prepared(1, "b", [...shared(6), ...unique("p", 2)])],
    });
    expect(belowBand.decisions[1]?.score).toBeCloseTo(0.5, 10);
    expect(belowBand.decisions[1]?.kind).toBe("no-match");
  });

  it("rejects a threshold order that would make the band impossible", async () => {
    await expect(
      runMatnCascade({ rows: [], autoThreshold: 0.5, bandThreshold: 0.9 }),
    ).rejects.toThrow(/thresholds/u);
  });

  it("rejects a duplicate row index", async () => {
    await expect(
      runMatnCascade({ rows: [prepared(0, "a", ["x"]), prepared(0, "b", ["y"])] }),
    ).rejects.toThrow(/duplicate row index/u);
  });
});

describe("the ambiguity rule", () => {
  it("quarantines a row within the margin of two groups, before asking the model", async () => {
    let asked = 0;
    // Row 1 shares nothing enough to join row 0, so it starts its own group; row 2 then
    // scores 0.667 against both groups and is the ambiguous case by construction.
    const rows = [
      prepared(0, "a", window(0, 10)),
      prepared(1, "b", window(4, 10)),
      prepared(2, "c", window(2, 10)),
    ];
    const result = await runMatnCascade({
      rows,
      budget: createCallBudget(10),
      adjudicate: async () => {
        asked += 1;
        return "same";
      },
    });
    expect(result.decisions[1]?.kind).toBe("no-match");
    expect(result.decisions[2]?.kind).toBe("quarantined");
    expect(result.quarantined[0]?.rule).toBe("ambiguous_best_match");
    expect(asked).toBe(0);
    expect(result.groups).toHaveLength(2);
  });

  it("does not quarantine when the top two differ by more than the margin", async () => {
    const rows = [
      prepared(0, "a", window(0, 10)),
      prepared(1, "b", window(4, 10)),
      prepared(2, "c", [...window(2, 8), ...unique("x", 2)]),
    ];
    const result = await runMatnCascade({ rows });
    expect(result.decisions[2]?.score).toBeCloseTo(2 / 3, 6);
    expect(result.decisions[2]?.kind).toBe("band-unresolved");
    expect(result.quarantined).toHaveLength(0);
  });
});

describe("the model band", () => {
  const bandRows = (): [PreparedRow, PreparedRow] => [
    prepared(0, "a", shared(10)),
    prepared(1, "b", shared(8)),
  ];

  it("joins the group on a 'same' verdict", async () => {
    const result = await runMatnCascade({
      rows: bandRows(),
      budget: createCallBudget(10),
      adjudicate: async () => "same",
    });
    expect(result.decisions[1]?.kind).toBe("model-same");
    expect(result.model.calls).toBe(1);
    expect(result.groups).toHaveLength(1);
  });

  it("starts a new group on a 'different' verdict", async () => {
    const result = await runMatnCascade({
      rows: bandRows(),
      budget: createCallBudget(10),
      adjudicate: async () => "different",
    });
    expect(result.decisions[1]?.kind).toBe("model-different");
    expect(result.groups).toHaveLength(2);
  });

  it("quarantines an uncertain verdict instead of merging or splitting it", async () => {
    const result = await runMatnCascade({
      rows: bandRows(),
      budget: createCallBudget(10),
      adjudicate: async () => "uncertain",
    });
    expect(result.quarantined[0]?.rule).toBe("model_uncertain");
    expect(result.decisions[1]?.kind).toBe("quarantined");
    expect(result.groups).toHaveLength(1);
  });

  it("refuses an adjudicator without a call budget", async () => {
    await expect(
      runMatnCascade({ rows: bandRows(), adjudicate: async () => "same" }),
    ).rejects.toThrow(/call budget/u);
  });

  it("stops calling at the ceiling and leaves the remaining rows unresolved", async () => {
    const rows = [
      prepared(0, "a", shared(10)),
      prepared(1, "b", shared(8)),
      prepared(2, "c", window(1, 10)),
      prepared(3, "d", shared(9)),
    ];
    let calls = 0;
    const budget = createCallBudget(1);
    const result = await runMatnCascade({
      rows,
      budget,
      adjudicate: async () => {
        calls += 1;
        return "different";
      },
    });
    expect(calls).toBe(1);
    expect(budget.calls).toBe(1);
    expect(result.model.ceilingReached).toBe(true);
    expect(result.model.status).toBe("ceiling-reached");
    expect(result.counts.bandUnresolved).toBeGreaterThan(0);
  });

  it("propagates a non-ceiling adjudicator failure instead of degrading it to a verdict", async () => {
    await expect(
      runMatnCascade({
        rows: bandRows(),
        budget: createCallBudget(10),
        adjudicate: async () => {
          throw new Error("provider 500");
        },
      }),
    ).rejects.toThrow(/provider 500/u);
  });
});

describe("the call ceiling", () => {
  it("is what a spent budget raises", () => {
    const budget = createCallBudget(1);
    budget.take();
    expect(() => budget.take()).toThrow(ModelCallCeilingError);
  });
});
