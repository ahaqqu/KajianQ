import { describe, expect, it } from "vite-plus/test";
import {
  createChildMatchIndex,
  type ChildMatchIndex,
  type MatnTarget,
} from "./sanadset-ingest-match";
import { matnTrigrams, normalizeMatnText } from "./sanadset-text";
import { MATN_A, fullNarration } from "./test-utils/sanadset-pilot-fixture";

/**
 * Test intent, named before the assertions:
 * - trap: containment is not evidence by itself. A one-word formula, a short
 *   common phrase, a matn split across a narration and a matn quoted inside a
 *   much longer text all score at or near 1.0 on trigrams, and each must be
 *   refused as a fragment with the measured reason rather than attached;
 * - trap: the guards must not refuse the intended relation. The matn as the tail
 *   of a narration, and an exact short matn, must still be targets — a guard that
 *   makes the pilot match nothing is as wrong as one that matches everything;
 * - trap: a refused group must name the child and the failed test, so a reader can
 *   tell a one-word fragment from a scattered or over-long one.
 */

const FILLER =
  "قال حدثنا أخبرنا عن ابن عمر أن رسول الله صلى الله عليه وسلم ذكر حديثا طويلا في مجلس " +
  "من مجالس العلم والذكر ثم سأله رجل عن معنى ذلك فبينه له بيانا شافيا ثم انصرف القوم " +
  "وهم يذكرون ما سمعوا في ذلك المجلس من العلم والذكر";

function query(matn: string) {
  const normalizedMatn = normalizeMatnText(matn);
  return { rawMatn: matn, normalizedMatn, trigrams: matnTrigrams(normalizedMatn) };
}

function indexOf(
  texts: readonly string[],
  options: { readonly autoThreshold?: number } = {},
): ChildMatchIndex {
  return createChildMatchIndex(
    texts.map((textRaw, index) => ({ id: `child-${index}`, textRaw, collection: "bukhari" })),
    {
      collection: "bukhari",
      autoThreshold: options.autoThreshold ?? 0.9,
      ambiguityMargin: 0.02,
    },
  );
}

function matchOne(index: ChildMatchIndex, matn: string): MatnTarget {
  return index.match(query(matn));
}

function fragmentaryReason(target: MatnTarget): string {
  if (target.kind !== "fragmentary") throw new Error(`expected fragmentary, got ${target.kind}`);
  return target.reason;
}

describe("the child match index's containment guards", () => {
  it("keeps an exact one-word matn: equality is evidence the guards do not weigh", () => {
    const target = matchOne(indexOf(["وحده"]), "وحده");
    expect(target).toEqual({ kind: "existing", childId: "child-0", how: "exact", score: 1 });
  });

  it("matches the whole matn as the tail of a stored narration", () => {
    const target = matchOne(indexOf([fullNarration(MATN_A)]), MATN_A);
    expect(target).toMatchObject({
      kind: "existing",
      childId: "child-0",
      how: "containment",
    });
  });

  it("quarantines a one-word matn quoted inside a long narration", () => {
    const target = matchOne(indexOf([fullNarration(`${FILLER} وحده ${FILLER}`)]), "وحده");
    expect(target).toMatchObject({ kind: "fragmentary", childId: "child-0" });
    expect(fragmentaryReason(target)).toContain("1 distinct token");
    expect(fragmentaryReason(target)).toContain("floor is 4");
  });

  it("quarantines a four-token matn below the character floor", () => {
    const matn = "قل هو الله احد";
    const target = matchOne(indexOf([fullNarration(`${FILLER} ${matn} ${FILLER}`)]), matn);
    expect(target.kind).toBe("fragmentary");
    expect(fragmentaryReason(target)).toContain("normalized characters");
    expect(fragmentaryReason(target)).toContain("floor is 16");
  });

  it("quarantines a matn that only occurs in pieces, not as one window", () => {
    const tokens = normalizeMatnText(MATN_A).split(" ");
    const half = Math.floor(tokens.length / 2);
    const split = fullNarration(
      `${tokens.slice(0, half).join(" ")} ${FILLER} … ${tokens.slice(half).join(" ")}`,
    );
    const target = matchOne(indexOf([split]), MATN_A);
    expect(target.kind).toBe("fragmentary");
    expect(fragmentaryReason(target)).toContain("matched tokens span");
    expect(fragmentaryReason(target)).toContain("ceiling is 2.5x");
  });

  it("quarantines a matn inside a much longer narration", () => {
    const long = fullNarration(`${MATN_A} ${FILLER} ${FILLER} ${FILLER} ${FILLER} ${FILLER}`);
    const target = matchOne(indexOf([long]), MATN_A);
    expect(target.kind).toBe("fragmentary");
    expect(fragmentaryReason(target)).toContain("the stored narration is");
    expect(fragmentaryReason(target)).toContain("ceiling is 8x");
  });

  it("quarantines a matn whose tokens are only partly present", () => {
    // The band threshold is lowered so the partly-present pair reaches the target
    // branch: the guard under test is token coverage, not the auto threshold.
    const half = MATN_A.split(" ").slice(0, 8).join(" ");
    const target = matchOne(indexOf([fullNarration(half)], { autoThreshold: 0.4 }), MATN_A);
    expect(target.kind).toBe("fragmentary");
    expect(fragmentaryReason(target)).toContain("of the matn's tokens occur");
    expect(fragmentaryReason(target)).toContain("floor is 80%");
  });

  it("returns new when no candidate reaches the auto threshold", () => {
    const target = matchOne(indexOf([fullNarration(FILLER)]), MATN_A);
    expect(target).toEqual({ kind: "new" });
  });
});
