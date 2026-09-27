import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Chunk } from "@app/rag-core";
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
 * Review B1 widened the alphabet from an enumerated 13-character list to a
 * **systematic sweep over the Unicode classes** a generator can glue to a
 * citation's tail — punctuation, symbols, superscripts/subscripts, combining
 * marks, whitespace, and the address-bearing digit and letter classes — so the
 * property states the class, not the shapes somebody happened to find. The
 * enumerated list omitted every shape the class-closure hunt turned up (ASCII
 * hyphen, U+2012, U+2015, `¹`, `:1`, full-width `：`, glued `(`), which is
 * exactly why the suite stayed green on a head that still false-refused
 * grounded citations (A1/A2).
 *
 * The sweep states the boundary too, not only the noise. Two classes are
 * deliberately NOT noise, and a future widening of the tail rule that starts
 * grounding them fails here rather than in production:
 *
 *  - `\p{Nd}` digits and `\p{L}` letters glued straight onto the number
 *    continue the address token (`no. 50102`, `no. 5010a` are different
 *    addresses than `no. 5010`), so they must never reduce to the bare number;
 *  - a dash (`\p{Pd}`) joined to a number is the closed-up range form, kept
 *    whole so an unretrieved second address is never dropped from validation
 *    (A3's precision-for-safety trade-off, `DASH_JOINED_NUMBER_TAIL`).
 */

/** Addresses in the product's grammars. */
const ADDRESSES = ["QS. 2:255", "QS. 114:6", "HR. Bukhari no. 5010", "HR. Abu Dawud no. 1"];

/** A retrieved chunk carrying one citation label. */
function chunk(label: string): Chunk {
  return { id: `c-${label}`, text: "evidence", metadata: { citation: label } };
}

/**
 * One representative per Unicode class that can appear in a citation's tail.
 * `noise: true` means "carries no address information": a label that differs
 * from an address only by such characters must reduce to that address and
 * ground. Dashes are listed here as noise *on their own* — a dash followed by
 * a number is the compound case, pinned separately below.
 */
const NOISE_CLASSES = [
  {
    name: "punctuation (\\p{P})",
    chars: [":", ";", ",", ".", ")", "]", "(", "…", '"', "'", "*", "،", "؛", "：", "؟"],
  },
  { name: "dashes (\\p{Pd})", chars: ["-", "‐", "‑", "‒", "–", "—", "―", "−"] },
  { name: "symbols (\\p{S})", chars: ["+", "=", "$", "©", "°", "±"] },
  { name: "superscripts/subscripts (\\p{No})", chars: ["¹", "²", "⁵", "₀", "₃", "½"] },
  { name: "combining marks (\\p{M})", chars: ["\u0301", "\u0308", "\u0651"] },
  { name: "whitespace (\\s)", chars: [" ", "\u00a0", "\t", "\u2003"] },
] as const;

/**
 * The address-bearing classes: characters that continue the number token
 * itself. They are NOT noise, and the tests below pin the fail-closed
 * direction — a label carrying one must never reduce to the bare address.
 */
const ADDRESS_BEARING_CLASSES = [
  { name: "digits (\\p{Nd})", chars: ["0", "2", "7", "9", "٣", "٥"] },
  { name: "letters (\\p{L})", chars: ["a", "Z", "é", "ا", "中"] },
] as const;

/** Every noise character, for the randomized combination properties. */
const NOISE_POOL: readonly string[] = NOISE_CLASSES.flatMap(({ chars }) => [...chars]);

describe("normalizeCitationLabel — property (#253 tail class, review B1)", () => {
  it("drops every Unicode class that carries no address information", () => {
    for (const { name, chars } of NOISE_CLASSES) {
      for (const address of ADDRESSES) {
        for (const char of chars) {
          const label = `${address}${char}`;
          expect(normalizeCitationLabel(label), `${name} after ${address}`).toBe(address);
          // …and the gate grounds the citation written that way.
          const { ungrounded } = validateCitations(`Lihat ${label} lanjut`, [chunk(address)]);
          expect(ungrounded, `${name} after ${address}`).toEqual([]);
        }
      }
    }
  });

  it("drops a pair of noise classes, including a footnote pair and a bracketed pair", () => {
    // Pairs are where the enumerated list was thinnest: `:1` (the footnote),
    // `¹:`, `)：`, `：:`, `…¹`. A pair of noise characters carries no address
    // either, so the label still reduces to the address. The dash+superscript
    // pairs pin the compound guard's boundary: `\p{No}` superscripts are
    // footnote markers, not the decimal digits an address is made of, so a
    // dash before one does NOT keep the compound (a dash before `1` does —
    // see the A3 property below).
    for (const pair of [
      ":1",
      ":12",
      "¹:",
      ":¹",
      ")：",
      "：:",
      "…¹",
      "\u0301:",
      "،1",
      "+1",
      "—¹",
      "–½",
      "—¹:",
    ]) {
      for (const address of ADDRESSES) {
        expect(normalizeCitationLabel(`${address}${pair}`), `${pair} after ${address}`).toBe(
          address,
        );
      }
    }
  });

  it("keeps an address-bearing glue distinct from the bare address (fail-closed)", () => {
    for (const { name, chars } of ADDRESS_BEARING_CLASSES) {
      for (const char of chars) {
        const glued = `HR. Bukhari no. 5010${char}`;
        expect(normalizeCitationLabel(glued), `${name} glued to the hadith number`).not.toBe(
          "HR. Bukhari no. 5010",
        );
        const { ungrounded } = validateCitations(`Lihat ${glued} menjelaskan`, [
          chunk("HR. Bukhari no. 5010"),
        ]);
        expect(ungrounded, `${name} glued to the hadith number`).not.toEqual([]);
      }
    }
    // The Quran address ends at its verse digits by its own grammar, so a
    // letter after them is outside the address and drops; digit glue still
    // extends the verse number (a different address).
    expect(normalizeCitationLabel("QS. 2:255a")).toBe("QS. 2:255");
    expect(normalizeCitationLabel("QS. 2:2550")).toBe("QS. 2:2550");
  });

  it("keeps a dash joined to a number whole — the deliberate A3 trade-off", () => {
    for (const dash of NOISE_CLASSES[1].chars) {
      for (const number of ["3", "5011", "٥٠١١"]) {
        const compound = `HR. Bukhari no. 5010${dash}${number}`;
        expect(normalizeCitationLabel(compound), compound).toBe(compound);
        const { ungrounded } = validateCitations(`Lihat ${compound} menjelaskan`, [
          chunk("HR. Bukhari no. 5010"),
          chunk("HR. Bukhari no. 5011"),
        ]);
        // Refused even with both addresses retrieved: the accepted cost of
        // never dropping a possibly-unretrieved second address.
        expect(ungrounded, compound).toEqual([compound]);
      }
    }
  });

  it("never lets a tail of noise classes change a label", () => {
    const property = fc.property(
      fc.constantFrom(...ADDRESSES),
      fc.array(fc.constantFrom(...NOISE_POOL), { minLength: 0, maxLength: 6 }),
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
      fc.array(fc.constantFrom(...NOISE_POOL), { minLength: 0, maxLength: 3 }),
      (surah, ayah, noise) => {
        const address = `QS. ${surah}:${ayah}`;
        expect(normalizeCitationLabel(address)).toBe(address);
        // A trailing tail is dropped; the address's own colon is not.
        expect(normalizeCitationLabel(`${address}${noise.join("")}`)).toBe(address);
        expect(citationCandidatesIn(`${address}: lanjut`)).toEqual([address]);
      },
    );
    expect(fc.assert(property, { numRuns: 300 })).toBeUndefined();
  });

  it("is idempotent", () => {
    const property = fc.property(
      fc.constantFrom(...ADDRESSES),
      fc.array(fc.constantFrom(...NOISE_POOL), { minLength: 0, maxLength: 6 }),
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
      fc.array(fc.constantFrom(...NOISE_POOL), { minLength: 0, maxLength: 4 }),
      (ayah, noise) => {
        const fabricated = `QS. 9:${900 + ayah}`;
        const { ungrounded } = validateCitations(
          `Allah berfirman dalam ${fabricated}${noise.join("")} tentang hal ini`,
          [chunk("QS. 2:255")],
        );
        expect(ungrounded).toEqual([fabricated]);
      },
    );
    expect(fc.assert(property, { numRuns: 300 })).toBeUndefined();
  });

  it("still refuses a fabricated hadith number however its tail is punctuated", () => {
    // The hadith half of the same property: the number is the identity, so no
    // tail — footnote, marker, markdown or prose punctuation — may ground an
    // invented number on a retrieved one.
    const property = fc.property(
      fc.integer({ min: 6000, max: 99999 }),
      fc.array(fc.constantFrom(...NOISE_POOL), { minLength: 0, maxLength: 4 }),
      (number, noise) => {
        const fabricated = `HR. Bukhari no. ${number}`;
        const { ungrounded } = validateCitations(
          `Rasulullah bersabda dalam ${fabricated}${noise.join("")} tentang hal ini`,
          [chunk("HR. Bukhari no. 5010")],
        );
        expect(ungrounded).toEqual([fabricated]);
      },
    );
    expect(fc.assert(property, { numRuns: 300 })).toBeUndefined();
  });
});
