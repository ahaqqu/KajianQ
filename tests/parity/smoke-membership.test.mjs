import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { selectSmokeSubset } from "../../packages/eval/src/smoke-subset";
import { SMOKE_COVERAGE_TAGS } from "../../packages/kajianq-domain/src/taxonomy";

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
 * still has to keep these ids.
 */

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../../packages/kajianq-domain/fixtures/golden-set-v0.json", import.meta.url),
    "utf8",
  ),
);

/** The cases the product requires the smoke to exercise, in the subset's order. */
const REQUIRED_IDS = ["gs-v0-019", "gs-v0-020", "gs-v0-018", "gs-v0-015", "gs-v0-001"];

describe("the staged smoke subset's required membership", () => {
  it("is exactly the product's required cases at the spec's default size", () => {
    const { set, reasons } = selectSmokeSubset(FIXTURE, { requiredTags: SMOKE_COVERAGE_TAGS });
    expect(set.questions.map((q) => q.id)).toEqual(REQUIRED_IDS);
    // Each required label class is reported under its own tag, so the run's
    // printed plan names the coverage it bought.
    expect(reasons.map((r) => r.reason)).toEqual([
      "refusal coverage",
      ...SMOKE_COVERAGE_TAGS.map((tag) => `required tag coverage: ${tag}`),
      "English language coverage",
      "Indonesian answer coverage",
    ]);
  });

  it("keeps the cross-madzhab case an answer question with no citation floor", () => {
    // The case pins the over-refusal dimension: it expects an answer, and its
    // empty `requiredCitations` is what makes a refusal the failure it measures.
    const { set } = selectSmokeSubset(FIXTURE, { requiredTags: SMOKE_COVERAGE_TAGS });
    const pinned = set.questions.find((q) => q.id === "gs-v0-018");
    expect(pinned).toBeDefined();
    expect(pinned.expectedBehavior).toBe("answer");
    expect(pinned.requiredCitations).toEqual([]);
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
      selectSmokeSubset(withoutCrossMadzhab, { requiredTags: SMOKE_COVERAGE_TAGS }),
    ).toThrow(/carries the required tag/);
  });
});
