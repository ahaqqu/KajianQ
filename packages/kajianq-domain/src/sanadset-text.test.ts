import { describe, expect, it } from "vite-plus/test";
import { fc, test as fcTest } from "@fast-check/vitest";
import {
  foldNarratorName,
  isReferenceOnlyMatn,
  jaccard,
  matnTrigrams,
  normalizeMatnText,
} from "./sanadset-text";

/**
 * Test intent, named before the assertions:
 * - trap: a fold that deletes a consonant would silently merge two narrators, so the
 *   fold is asserted to be a *strict* orthographic reduction, not a stemmer;
 * - trap: stripping the leading link phrase must never empty a real matn;
 * - trap: an empty trigram set must score 0, never 1, or two empty texts would "match".
 */

describe("foldNarratorName", () => {
  it("removes diacritics and tatweel without touching the root letters", () => {
    expect(foldNarratorName("مُحَمَّدُ بْنُ إِسْمَاعِيلَ")).toBe("محمد بن اسماعيل");
    expect(foldNarratorName("مـحـمـد")).toBe("محمد");
  });

  it("collapses alef variants and ta-marbuta onto one form", () => {
    const alef = foldNarratorName("أَحْمَد");
    expect(foldNarratorName("إِحْمَد")).toBe(alef);
    expect(foldNarratorName("ٱحمد")).toBe(alef);
    expect(foldNarratorName("فاطمة")).toBe(foldNarratorName("فاطمه"));
    expect(foldNarratorName("يحيى")).toBe(foldNarratorName("يحيي"));
  });

  it("strips honorifics but keeps the name they follow", () => {
    expect(foldNarratorName("أَبُو هُرَيْرَةَ رضي الله عنه")).toBe("ابو هريره");
    expect(foldNarratorName("عَلِيٌّ عَلَيْهِ السَّلَام")).toBe("علي");
    expect(foldNarratorName("النَّبِيُّ ﷺ")).toBe("النبي");
  });

  it("is a strict reduction: a distinguishing consonant is never removed", () => {
    expect(foldNarratorName("حَرْب")).not.toBe(foldNarratorName("حَزْب"));
    expect(foldNarratorName("سَعِيد")).not.toBe(foldNarratorName("سَعْد"));
  });

  it("collapses two spellings that differ only in diacritics", () => {
    expect(foldNarratorName("سَعِيد")).toBe(foldNarratorName("سُعَيْد"));
  });

  it("drops tag spans and punctuation rather than gluing words together", () => {
    expect(foldNarratorName("<IDF>نوع المخطوط</IDF> مَالِكُ بْنُ أَنَسٍ")).toBe("مالك بن انس");
    expect(foldNarratorName("مَالِكٌ، بْنُ أَنَسٍ.")).toBe("مالك بن انس");
  });
});

describe("normalizeMatnText", () => {
  it("strips the leading transmission phrase when text remains", () => {
    const normalized = normalizeMatnText("  ، عن النبي ﷺ ، قال : إنما الأعمال بالنيات");
    expect(normalized.startsWith("انما")).toBe(true);
    expect(normalized.includes("الاعمال")).toBe(true);
  });

  it("falls back to the folded text when stripping would empty it", () => {
    expect(normalizeMatnText("عن النبي ﷺ قال")).toBe("عن النبي قال");
  });

  it("folds a matn that carries no link phrase unchanged in content", () => {
    expect(normalizeMatnText("إِنَّمَا الأَعْمَالُ بِالنِّيَّاتِ")).toBe("انما الاعمال بالنيات");
    expect(normalizeMatnText("")).toBe("");
  });
});

describe("isReferenceOnlyMatn", () => {
  it("flags a cross-reference and not a real text", () => {
    expect(isReferenceOnlyMatn("مثله")).toBe(true);
    expect(isReferenceOnlyMatn("بهذا الاسناد")).toBe(true);
    expect(isReferenceOnlyMatn("انما الاعمال بالنيات")).toBe(false);
    expect(isReferenceOnlyMatn("")).toBe(false);
  });
});

describe("matnTrigrams", () => {
  it("is the sorted unique set of character trigrams", () => {
    expect(matnTrigrams("abcd")).toEqual(["abc", "bcd"]);
    expect(matnTrigrams("aa")).toEqual(["aa"]);
    expect(matnTrigrams("")).toEqual([]);
  });
});

describe("jaccard", () => {
  it("scores identical sets 1 and disjoint sets 0", () => {
    expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
    expect(jaccard(["a"], ["b"])).toBe(0);
  });

  it("treats an empty side as no evidence rather than a perfect match", () => {
    expect(jaccard([], [])).toBe(0);
    expect(jaccard([], ["a"])).toBe(0);
  });

  fcTest.prop([
    fc.array(fc.string({ minLength: 3, maxLength: 3 }), { maxLength: 24 }),
    fc.array(fc.string({ minLength: 3, maxLength: 3 }), { maxLength: 24 }),
  ])("is symmetric and bounded on generated sets", (left, right) => {
    const forward = jaccard([...new Set(left)].sort(), [...new Set(right)].sort());
    const backward = jaccard([...new Set(right)].sort(), [...new Set(left)].sort());
    expect(forward).toBe(backward);
    expect(forward).toBeGreaterThanOrEqual(0);
    expect(forward).toBeLessThanOrEqual(1);
  });

  fcTest.prop([fc.string({ minLength: 3, maxLength: 40 })])("scores identical text 1", (text) => {
    const grams = matnTrigrams(foldNarratorName(text));
    if (grams.length === 0) return;
    expect(jaccard(grams, grams)).toBe(1);
  });
});
