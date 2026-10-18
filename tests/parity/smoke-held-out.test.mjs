import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { selectSmokeSubset, SmokeSubsetError } from "../../packages/eval/src/smoke-subset";
import { DAIF_TRAP_LABEL, SMOKE_HELD_OUT_IDS } from "../../packages/kajianq-domain/src/taxonomy";

/**
 * Cross-package pin: the staged Golden Set smoke's default sample, measured on
 * the real fixture. It lives under `tests/` because the fixture and the held-out
 * curation belong to the domain pack and the selector to the engine, and neither
 * package may import the other's source for a test.
 *
 * The pin is membership, not the selector's mechanism: re-curating the fixture,
 * renaming a label, reshuffling the selection rule, or re-admitting a held-out
 * question reddens this suite instead of silently changing what the deploy gate
 * asks. A held-out question stays in the full set — the sample shrinks, the set
 * does not — so the case is still asked in the full Golden Set and in QA.
 */

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../../packages/kajianq-domain/fixtures/golden-set-v0.json", import.meta.url),
    "utf8",
  ),
);

/** The cases the default sample asks, in the subset's order. */
const DEFAULT_IDS = ["gs-v0-019", "gs-v0-020", "gs-v0-001", "gs-v0-002", "gs-v0-005"];

const select = () =>
  selectSmokeSubset(FIXTURE, { trapTag: DAIF_TRAP_LABEL, exclude: SMOKE_HELD_OUT_IDS });

describe("the staged smoke's default sample", () => {
  it("is exactly the cases the product samples at the spec's default size", () => {
    const { set, reasons } = select();
    expect(set.questions.map((q) => q.id)).toEqual(DEFAULT_IDS);
    // The classes the fixture still carries fill from the rest of the set, so an
    // exclusion cannot silently drop the coverage the sample promises. The English
    // class is absent because every English case is held out; the cadence policy
    // promises it only while the fixture carries a stable one.
    expect(reasons.map((r) => r.reason)).toEqual([
      "refusal coverage",
      "trap coverage",
      "Indonesian answer coverage",
      "fill (stable order)",
      "fill (stable order)",
    ]);
  });

  it("asks none of the held-out questions", () => {
    const ids = select().set.questions.map((q) => q.id);
    for (const id of SMOKE_HELD_OUT_IDS) expect(ids).not.toContain(id);
    expect(SMOKE_HELD_OUT_IDS).not.toHaveLength(0);
  });

  it("keeps the held-out cases in the full set, unweakened", () => {
    const held = FIXTURE.questions.filter((q) => SMOKE_HELD_OUT_IDS.includes(q.id));
    // One row per held-out id: a typo, a rename, or a re-curation that drops the
    // case reddens here rather than leaving a gate that samples nothing in its place.
    expect(held.map((q) => q.id)).toEqual([...SMOKE_HELD_OUT_IDS]);
    for (const q of held) {
      expect(q.expectedBehavior).toBe("answer");
      expect(q.expectedSourceTypes.length).toBeGreaterThan(0);
    }
    // The full set still carries every held-out case; only the sample is narrower.
    const all = FIXTURE.questions.map((q) => q.id);
    for (const id of SMOKE_HELD_OUT_IDS) expect(all).toContain(id);
  });

  it("reddens when the fixture no longer carries a held-out id", () => {
    const without = {
      ...FIXTURE,
      questions: FIXTURE.questions.filter((q) => !SMOKE_HELD_OUT_IDS.includes(q.id)),
    };
    expect(() =>
      selectSmokeSubset(without, { trapTag: DAIF_TRAP_LABEL, exclude: SMOKE_HELD_OUT_IDS }),
    ).toThrow(SmokeSubsetError);
  });
});
