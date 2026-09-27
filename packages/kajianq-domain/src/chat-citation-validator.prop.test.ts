import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  citationCandidatesIn,
  normalizeCitationLabel,
  validateCitations,
} from "./chat-citation-validator";

/**
 * The #253 invariant, machine-checked: **a citation's tail is punctuation, not
 * identity.** `normalizeCitationLabel` is the one boundary both the retrieved
 * chunk's label and the draft's extracted span pass through, so the property
 * is stated against it directly and against the gate that consumes it.
 *
 * The table tests in `chat-citation-validator.test.ts` pin the shapes the
 * generator actually emitted; these properties close the class over every
 * combination of them, including the ones nobody enumerated — a fix for the
 * colon alone would pass the table and fail `tail noise never changes a
 * label`.
 */

/** The punctuation a generator can attach to a citation's tail. */
const NOISE_CHARS = [":", ";", ",", ".", ")", "]", "—", "…", '"', "'", "*", "`", " "];

/** Addresses in the product's grammars: both end in the address digits. */
const ADDRESSES = ["QS. 2:255", "QS. 114:6", "HR. Bukhari no. 5010", "HR. Abu Dawud no. 1"];

describe("normalizeCitationLabel — property (#253 tail class)", () => {
  it("never lets trailing punctuation change a label", () => {
    const property = fc.property(
      fc.constantFrom(...ADDRESSES),
      fc.array(fc.constantFrom(...NOISE_CHARS), { minLength: 0, maxLength: 6 }),
      (address, noise) => {
        expect(normalizeCitationLabel(`${address}${noise.join("")}`)).toBe(address);
      },
    );
    expect(fc.assert(property, { numRuns: 300 })).toBeUndefined();
  });

  it("never removes the colon inside a Quran address", () => {
    const property = fc.property(
      fc.integer({ min: 1, max: 114 }),
      fc.integer({ min: 1, max: 286 }),
      (surah, ayah) => {
        const address = `QS. ${surah}:${ayah}`;
        expect(normalizeCitationLabel(address)).toBe(address);
        // A trailing tail is dropped; the address's own colon is not.
        expect(normalizeCitationLabel(`${address}:`)).toBe(address);
        expect(citationCandidatesIn(`${address}: lanjut`)).toEqual([address]);
      },
    );
    expect(fc.assert(property, { numRuns: 300 })).toBeUndefined();
  });

  it("is idempotent", () => {
    const property = fc.property(
      fc.constantFrom(...ADDRESSES),
      fc.array(fc.constantFrom(...NOISE_CHARS), { minLength: 0, maxLength: 6 }),
      (address, noise) => {
        const once = normalizeCitationLabel(`${address}${noise.join("")}`);
        expect(normalizeCitationLabel(once)).toBe(once);
      },
    );
    expect(fc.assert(property, { numRuns: 300 })).toBeUndefined();
  });

  it("still refuses a fabricated address however its tail is punctuated", () => {
    // The safety direction of the same property: tail noise is dropped, the
    // address is not — so an address no chunk grounds stays ungrounded.
    const property = fc.property(
      fc.integer({ min: 1, max: 286 }),
      fc.array(fc.constantFrom(...NOISE_CHARS), { minLength: 0, maxLength: 4 }),
      (ayah, noise) => {
        const fabricated = `QS. 9:${900 + ayah}`;
        const { ungrounded } = validateCitations(
          `Allah berfirman dalam ${fabricated}${noise.join("")} tentang hal ini`,
          [{ id: "c1", text: "evidence", metadata: { citation: "QS. 2:255" } }],
        );
        expect(ungrounded).toEqual([fabricated]);
      },
    );
    expect(fc.assert(property, { numRuns: 300 })).toBeUndefined();
  });
});
