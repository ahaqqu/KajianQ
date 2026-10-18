import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  formatSmokePlan,
  selectSmokeSubset,
  SmokeSubsetError,
} from "../../packages/eval/src/smoke-subset";
import {
  SMOKE_COVERAGE_TAGS,
  SMOKE_HELD_OUT_IDS,
} from "../../packages/kajianq-domain/src/taxonomy";

/**
 * Cross-package pin: the staged Golden Set smoke must always include the label
 * classes the product requires, measured on the real fixture. It lives under
 * `tests/` because the fixture belongs to the domain pack and the selector to
 * the engine, and neither package may import the other's source for a test.
 *
 * The pin is the membership itself, not the selector's mechanism: re-curating
 * the fixture, renaming a label, or reshuffling the selection rule reddens this
 * suite instead of silently shrinking the gate that runs on every deploy. The
 * subset's default size is the deployed smoke's; a fixture that grows past it
 * still has to keep these ids. Held-out questions are pinned too — as absent
 * from the sample, present and unweakened in the full set, and reported by the
 * plan so the coverage they take with them can never pass silently.
 */

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../../packages/kajianq-domain/fixtures/golden-set-v0.json", import.meta.url),
    "utf8",
  ),
);

/** The cases the deployed sample asks, in the subset's order. */
const DEFAULT_IDS = ["gs-v0-019", "gs-v0-020", "gs-v0-018", "gs-v0-001", "gs-v0-002"];

const select = () =>
  selectSmokeSubset(FIXTURE, {
    requiredTags: SMOKE_COVERAGE_TAGS,
    exclude: SMOKE_HELD_OUT_IDS,
  });

describe("the staged smoke subset's default membership", () => {
  it("is exactly the cases the deployed gate samples at the default size", () => {
    const { set, reasons } = select();
    expect(set.questions.map((q) => q.id)).toEqual(DEFAULT_IDS);
    // Each required label class is reported under its own tag, so the run's
    // printed plan names the coverage it bought.
    expect(reasons.map((r) => r.reason)).toEqual([
      "refusal coverage",
      ...SMOKE_COVERAGE_TAGS.map((tag) => `required tag coverage: ${tag}`),
      "Indonesian answer coverage",
      "fill (stable order)",
    ]);
  });

  it("names the class it can no longer cover instead of passing silently", () => {
    const selection = select();
    expect(selection.unavailable).toEqual([
      {
        reason: "English language coverage",
        heldOut: ["gs-v0-015", "gs-v0-016", "gs-v0-017"],
      },
    ]);
    // The cross-madzhab case keeps the hadith path in the sample; nothing else
    // the full set asks for is dropped without a line.
    expect(selection.uncoveredSourceTypes).toEqual([]);
    const plan = formatSmokePlan(selection, FIXTURE).join("\n");
    expect(plan).toContain(
      "not covered: English language coverage (held out: gs-v0-015, gs-v0-016, gs-v0-017)",
    );
    expect(plan).not.toContain("not covered: expected source type");
  });

  it("keeps the cross-madzhab case an answer question with no citation floor", () => {
    // The case pins the over-refusal dimension: it expects an answer, and its
    // empty `requiredCitations` is what makes a refusal the failure it measures.
    const { set } = select();
    const pinned = set.questions.find((q) => q.id === "gs-v0-018");
    expect(pinned).toBeDefined();
    expect(pinned.expectedBehavior).toBe("answer");
    expect(pinned.requiredCitations).toEqual([]);
  });

  it("keeps every held-out case in the full set, unweakened", () => {
    const held = FIXTURE.questions.filter((q) => SMOKE_HELD_OUT_IDS.includes(q.id));
    expect(held.map((q) => q.id)).toEqual([...SMOKE_HELD_OUT_IDS]);
    for (const q of held) {
      expect(q.expectedBehavior).toBe("answer");
      expect(q.expectedSourceTypes.length).toBeGreaterThan(0);
    }
    // Only the sample is narrower; the full set and QA still ask every case.
    const all = FIXTURE.questions.map((q) => q.id);
    for (const id of SMOKE_HELD_OUT_IDS) expect(all).toContain(id);
    for (const id of SMOKE_HELD_OUT_IDS) expect(DEFAULT_IDS).not.toContain(id);
  });

  it("reddens when the fixture no longer carries a held-out case", () => {
    expect(SMOKE_HELD_OUT_IDS.length).toBeGreaterThan(0);
    const without = {
      ...FIXTURE,
      questions: FIXTURE.questions.filter((q) => !SMOKE_HELD_OUT_IDS.includes(q.id)),
    };
    expect(() =>
      selectSmokeSubset(without, {
        requiredTags: SMOKE_COVERAGE_TAGS,
        exclude: SMOKE_HELD_OUT_IDS,
      }),
    ).toThrow(SmokeSubsetError);
  });

  it("reddens when the fixture loses a required class instead of shrinking the gate", () => {
    const withoutCrossMadzhab = {
      ...FIXTURE,
      questions: FIXTURE.questions.map((q) => ({
        ...q,
        tags: (q.tags ?? []).filter((tag) => !SMOKE_COVERAGE_TAGS.includes(tag)),
      })),
    };
    expect(() =>
      selectSmokeSubset(withoutCrossMadzhab, {
        requiredTags: SMOKE_COVERAGE_TAGS,
        exclude: SMOKE_HELD_OUT_IDS,
      }),
    ).toThrow(/carries the required tag/);
  });
});
