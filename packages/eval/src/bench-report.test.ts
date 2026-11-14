import { describe, expect, it } from "vite-plus/test";
import {
  benchArmsTable,
  benchCostCell,
  benchGateCell,
  benchMissSection,
  fmtPct,
  p50LatencyMs,
} from "./bench-report";

/**
 * The four bench reports share these primitives, so their rules are pinned
 * once: an aborted arm never reads as its partial verdict, a cost cell never
 * hides a budget field that disagrees with the records, and the table and
 * miss sections keep the shape every report expects.
 */

describe("bench report primitives", () => {
  it("an aborted arm renders as an abort, never as its partial verdict", () => {
    expect(
      benchGateCell({ pass: true, pinnedPass: true, aborted: true, error: "vendor 500" }),
    ).toBe("**abort** ⚠ aborted (vendor 500)");
    expect(benchGateCell({ pass: false, pinnedPass: false, aborted: true })).toBe(
      "**abort** ⚠ aborted (unnamed failure)",
    );
  });

  it("a gate cell flags a verdict that disagrees with the run's pinned one", () => {
    expect(benchGateCell({ pass: true, pinnedPass: false, aborted: false })).toBe(
      "**pass** (pinned gate disagrees)",
    );
    expect(benchGateCell({ pass: false, pinnedPass: false, aborted: false })).toBe("**fail**");
  });

  it("the cost cell sums the records and names a budget field that disagrees", () => {
    const records = [{ cost: { costMicroUsd: 7 } }, { cost: { costMicroUsd: 5 } }, {}];
    expect(benchCostCell(records, 12)).toBe("12 µUSD total");
    expect(benchCostCell(records, 999)).toBe("12 µUSD total (budget bookkeeping 999)");
  });

  it("p50 takes the lower median and ignores records without a latency", () => {
    expect(p50LatencyMs([])).toBeNull();
    expect(p50LatencyMs([{ cost: { latencyMs: 900 } }, { cost: { latencyMs: 100 } }])).toBe(100);
    expect(
      p50LatencyMs([
        { cost: { latencyMs: 900 } },
        { cost: { latencyMs: 100 } },
        { cost: { latencyMs: 300 } },
        {},
      ]),
    ).toBe(300);
  });

  it("the arms table emits a header, one separator per column and one row per arm", () => {
    expect(benchArmsTable(["Model", "Gate"], [["`a`", "**pass**"]])).toEqual([
      "| Model | Gate |",
      "| --- | --- |",
      "| `a` | **pass** |",
    ]);
  });

  it("the miss section lists an arm with no misses and one with details", () => {
    const lines = benchMissSection([
      { model: "a", details: [] },
      { model: "b", details: ["`x`: expected `true`, got `0.3`"] },
    ]);
    expect(lines).toContain("- `a`: none.");
    expect(lines).toContain("- `b` (1):");
    expect(lines).toContain("  - `x`: expected `true`, got `0.3`");
  });

  it("percentages render one decimal and an em dash for a missing value", () => {
    expect(fmtPct(0.875)).toBe("87.5%");
    expect(fmtPct(null)).toBe("—");
  });
});
