import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Chunk } from "@app/rag-core";
import {
  addressesNamedBy,
  citationCandidatesIn,
  groundingLabelsFor,
  normalizeCitationLabel,
  validateCitations,
} from "./chat-citation-validator";
import { SURAH_AYAH_COUNTS } from "./surah-names";
import { declaresAddressList } from "./chat-citation-grammar";

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
 * #264 moved two more classes, and the sweep moved with them — but a tail-only
 * sweep cannot fail for either, which review B1 executed and showed:
 *
 *  - invisible formatting (`\p{Cf}`) is stripped in the flatten step, so it is
 *    noise at **every position**, not only the tail: `HR. Bukhari no. 5\u200c010`
 *    used to truncate to a retrieved prefix sibling, so the sweep below inserts
 *    it before the marker, inside a number and after it;
 *  - a fullwidth digit (`５`, U+FF15) folds to its ASCII value. Glued to a
 *    number it still continues that number (pinned below), but that row is true
 *    with or without the fold — the row that can fail is the fullwidth
 *    **rendering** of an address, which must reduce to the ASCII address.
 *
 * The rest of the sweep is **tail-only on purpose**: for punctuation, symbols,
 * superscripts, combining marks and whitespace, the tail is the whole claim —
 * each carries no address information where a tail can sit. The classes that
 * continue the token are pinned separately below.
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
 *    (A3's precision-for-safety trade-off, `DASH_JOINED_NUMBER_TAIL`, which
 *    #264 extended to the Quran compound `QS. 2:255—256`).
 */

/** Addresses in the product's grammars. */
const ADDRESSES = ["QS. 2:255", "QS. 114:6", "HR. Bukhari no. 5010", "HR. Abu Dawud no. 1"];

/** A retrieved chunk carrying one citation label. */
function chunk(label: string): Chunk {
  return { id: `c-${label}`, text: "evidence", metadata: { citation: label } };
}

/**
 * The dash family (`\p{Pd}`) on its own, named so the closed-up-range property
 * below cannot drift when a class is added to the sweep.
 */
const DASH_CHARS = ["-", "‐", "‑", "‒", "–", "—", "―", "−"] as const;

/**
 * The `\p{Cf}` characters the flatten step drops. Named because they are noise
 * at **every** position, not only the tail (review B1), so they sweep
 * differently from the tail-only classes below.
 */
const INVISIBLE_FORMATTING_CHARS = [
  "\u200b",
  "\u200c",
  "\u200d",
  "\u200e",
  "\u00ad",
  "\ufeff",
] as const;

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
  { name: "dashes (\\p{Pd})", chars: DASH_CHARS },
  { name: "symbols (\\p{S})", chars: ["+", "=", "$", "©", "°", "±"] },
  { name: "superscripts/subscripts (\\p{No})", chars: ["¹", "²", "⁵", "₀", "₃", "½"] },
  { name: "combining marks (\\p{M})", chars: ["\u0301", "\u0308", "\u0651"] },
  { name: "whitespace (\\s)", chars: [" ", "\u00a0", "\t", "\u2003"] },
  { name: "invisible formatting (\\p{Cf})", chars: INVISIBLE_FORMATTING_CHARS },
] as const;

/**
 * The address-bearing classes: characters that continue the number token
 * itself. They are NOT noise, and the tests below pin the fail-closed
 * direction — a label carrying one must never reduce to the bare address.
 * `５` is here because #264 folds the fullwidth block to ASCII first: it is
 * still a digit, so it still continues the number.
 */
const ADDRESS_BEARING_CLASSES = [
  { name: "digits (\\p{Nd})", chars: ["0", "2", "7", "9", "٣", "٥", "５"] },
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

  it("drops an invisible format character at EVERY position, not only the tail (B1)", () => {
    // Review B1 executed the mutation: with the sweep above appending class
    // characters at the tail only, reverting the `\p{Cf}` strip left this
    // suite 9/9 green while four unit tests reddened — the row could not fail.
    // The flatten step drops the class from the whole label before a grammar
    // reads it, so it is noise at every position; sweeping the positions is
    // what gives the row teeth (reverting the strip now reddens THIS test).
    for (const address of ADDRESSES) {
      for (const char of INVISIBLE_FORMATTING_CHARS) {
        for (let at = 0; at <= address.length; at += 1) {
          const glued = `${address.slice(0, at)}${char}${address.slice(at)}`;
          expect(normalizeCitationLabel(glued), `${char} at ${at} of ${address}`).toBe(address);
        }
      }
      // …and the gate grounds the citation however the glue is spelled, at the
      // structural positions a tail-only sweep never reached.
      for (const char of INVISIBLE_FORMATTING_CHARS) {
        const glued = `${address.slice(0, 2)}${char}${address.slice(2)}`;
        const { ungrounded } = validateCitations(`Lihat ${glued} lanjut`, [chunk(address)]);
        expect(ungrounded, `${char} inside ${address}`).toEqual([]);
      }
    }
  });

  it("folds a fullwidth rendering of every address digit (B1)", () => {
    // The ADDRESS_BEARING row below proves `５` continues a number — true with
    // or without the fold, because `５` is `\p{Nd}` either way. What only the
    // fold can satisfy is the fullwidth RENDERING of an address: without the
    // fold the digits stay fullwidth, the label does not equal its ASCII
    // address, and this test reddens (executed — that is its mutation proof).
    const fullwidth = (text: string) =>
      text.replace(/[0-9]/g, (digit) => String.fromCharCode((digit.charCodeAt(0) ?? 0) + 0xfee0));
    for (const address of ADDRESSES) {
      const rendered = fullwidth(address);
      expect(normalizeCitationLabel(rendered), rendered).toBe(address);
      expect(
        validateCitations(`Lihat ${rendered} lanjut`, [chunk(address)]).ungrounded,
        rendered,
      ).toEqual([]);
      // One digit at a time, so a mid-number fold is swept, not only a whole
      // fullwidth number.
      for (let at = 0; at < address.length; at += 1) {
        const digit = address[at] ?? "";
        if (!/[0-9]/.test(digit)) continue;
        const mixed = `${address.slice(0, at)}${fullwidth(digit)}${address.slice(at + 1)}`;
        expect(normalizeCitationLabel(mixed), mixed).toBe(address);
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

  it("keeps a dash joined to a number whole — per grammar, whole-label vs per-address", () => {
    // #264 gave both grammars the same absorption and the same whole-label
    // rule. ADR-0049 keeps that rule for a grammar that declares no address
    // list (the hadith number) and completes #264's own A3 follow-up for the
    // one that does (the Quran range), so the two grammars no longer share the
    // verdict — they share the constant. This property is what pins the split:
    // every dash spelling, both directions of the range.
    const hadith: string[] = [];
    const quranGrounds: string[] = [];
    const quranRefuses: string[] = [];
    for (const dash of DASH_CHARS) {
      for (const number of ["3", "5011", "٥٠١١"]) {
        hadith.push(`HR. Bukhari no. 5010${dash}${number}`);
      }
      // A tail that resolves to the retrieved second address (256) and tails
      // that do not: 257 was never retrieved, and ٢٥٦ is another script's
      // digits, which no ASCII corpus label grounds (the digit posture).
      for (const number of ["256"]) {
        quranGrounds.push(`QS. 2:255${dash}${number}`);
      }
      for (const number of ["257", "٢٥٦"]) {
        quranRefuses.push(`QS. 2:255${dash}${number}`);
      }
    }
    for (const compound of hadith) {
      // The label stays whole for display in both grammars.
      expect(normalizeCitationLabel(compound), compound).toBe(compound);
      // Refused even with both addresses retrieved: the accepted cost of never
      // dropping a possibly-unretrieved second address, unchanged for a
      // grammar with no declared list (ADR-0049's revisit trigger).
      expect(
        validateCitations(`Lihat ${compound} menjelaskan`, [
          chunk("HR. Bukhari no. 5010"),
          chunk("HR. Bukhari no. 5011"),
        ]).ungrounded,
        compound,
      ).toEqual([compound]);
    }
    for (const compound of quranGrounds) {
      expect(normalizeCitationLabel(compound), compound).toBe(compound);
      expect(
        validateCitations(`Lihat ${compound} menjelaskan`, [chunk("QS. 2:255"), chunk("QS. 2:256")])
          .ungrounded,
        compound,
      ).toEqual([]);
    }
    for (const compound of quranRefuses) {
      expect(normalizeCitationLabel(compound), compound).toBe(compound);
      expect(
        validateCitations(`Lihat ${compound} menjelaskan`, [chunk("QS. 2:255"), chunk("QS. 2:256")])
          .ungrounded,
        compound,
      ).toEqual([compound]);
    }
  });

  it("grounds a range of ONE address exactly when the address it names is retrieved (#444)", () => {
    // The invariant, swept over the shapes the grammar admits: a range whose
    // endpoints are equal names exactly the address its two endpoints spell, so
    // it grounds iff that address is in the retrieved set — for every joiner
    // spelling, in the glued form (the fix's class: refused at base) and in the
    // spaced form (a **no-regression** pin, not a widening of this fix: the head
    // address there is followed by a space, so the extension rule already
    // accepted all 16 of those shapes at base — 0 moved) — and in the refused
    // direction when only a NEIGHBOURING verse was retrieved. The rule used to be gated on
    // the declared list's length, so every one of these spans was refused with
    // the address in hand: on staging that replaced a 31-chunk grounded answer
    // with the canonical refusal (trace `b8812e2d-…`), silently — the refusal is
    // a legal answer, an empty frame is a legal frame, and nothing reddened.
    const property = fc.property(
      fc.integer({ min: 1, max: 114 }),
      fc.integer({ min: 1, max: 286 }),
      fc.constantFrom(...DASH_CHARS),
      (surah, rawAyah, dash) => {
        const count = SURAH_AYAH_COUNTS[surah - 1]!;
        const ayah = 1 + (rawAyah % count);
        const address = `QS. ${surah}:${ayah}`;
        const neighbour = `QS. ${surah}:${1 + (ayah % count)}`;
        // The glued form is the fix's class; the spaced twin was already
        // accepted at base through the extension rule, so it pins no
        // regression rather than a widening this change caused.
        const forms = [`${address}${dash}${ayah}`, `${address} ${dash} ${ayah}`];
        for (const form of forms) {
          // The declaration half: the range names ONE address — the one its
          // endpoints spell — and not merely the head of a written string.
          expect(addressesNamedBy(form), form).toEqual([address]);
          // The comparison half, at the one owner the gate and the frame share.
          expect(groundingLabelsFor(form, new Set([address])), form).toEqual([address]);
          expect(validateCitations(`Lihat ${form} ya`, [chunk(address)]).ungrounded, form).toEqual(
            [],
          );
          // The refused direction: a neighbouring verse retrieved is not the
          // address the span names, and the refusal still names the span.
          expect(groundingLabelsFor(form, new Set([neighbour])), form).toBeNull();
          expect(
            validateCitations(`Lihat ${form} ya`, [chunk(neighbour)]).ungrounded,
            form,
          ).toEqual([normalizeCitationLabel(form)]);
        }
      },
    );
    expect(fc.assert(property, { numRuns: 300 })).toBeUndefined();
  });

  it("never grounds a plain span on a marker it did not name — the whole address space (#449)", () => {
    // The class the declared-list branch's shape proxy left open, exhausted rather
    // than sampled: with a retrieved set holding the bare marker `QS.`, EVERY valid
    // `surah:ayah` address (6,236 — the Tanzil table's own total) was grounded on the
    // marker by the extension rule, in all three marker spellings the scan folds to
    // one candidate. The branch is keyed to the grammar's declaration now, so the
    // span's own declared list of one decides it, and the marker grounds nothing.
    //
    // Stated per address and per spelling: the marker-only family refuses, and the
    // family holding the address the span names grounds on that address and no other
    // label. A reinstated shape proxy reddens this test at its FIRST address
    // (`QS. 1:1`: expected null, received [ 'QS.' ]).
    const marker = "QS.";
    let addresses = 0;
    for (let surah = 1; surah <= SURAH_AYAH_COUNTS.length; surah += 1) {
      const count = SURAH_AYAH_COUNTS[surah - 1]!;
      for (let ayah = 1; ayah <= count; ayah += 1) {
        addresses += 1;
        const address = `QS. ${surah}:${ayah}`;
        for (const written of [address, `Q.S. ${surah}:${ayah}`, `QS ${surah}:${ayah}`]) {
          const candidate = citationCandidatesIn(`Lihat ${written} ya`)[0]!;
          expect(candidate, written).toBe(address);
          // The declaration is structural, so the per-address branch is taken.
          expect(declaresAddressList(candidate), written).toBe(true);
          // The class: nothing but the marker was retrieved, and it grounds nothing.
          expect(groundingLabelsFor(candidate, new Set([marker])), written).toBeNull();
          // The other direction: the address the span names grounds it, alone.
          expect(groundingLabelsFor(candidate, new Set([address])), written).toEqual([address]);
          expect(groundingLabelsFor(candidate, new Set([address, marker])), written).toEqual([
            address,
          ]);
        }
      }
    }
    // The ticket's own figure, reproduced: all 6,236 valid addresses are this class,
    // and the marker reaches none of them after the fix.
    expect(addresses).toBe(6236);
  });

  it("holds the declared-list laws over addresses x joiners x renderings x retrieved sets (#449)", () => {
    // The differential-free statement of the same change, over the shape space the
    // sweep measured (6,236 addresses x 8 joiners x 4 renderings x 6 retrieved-set
    // families = 1,197,348 combinations; 0 widened / 6,236 narrowed at base
    // `4003527`): however a retrieved set is composed, the verdict obeys the laws the
    // gate promises — never a label outside the retrieved set, never a grounding that
    // skips an address the span declares, never a marker grounding a span that does
    // not name the marker, and adding retrieved labels never refuses a citation the
    // gate already accepted.
    const marker = "QS.";
    const property = fc.property(
      fc.integer({ min: 1, max: 114 }),
      fc.integer({ min: 1, max: 286 }),
      fc.constantFrom(...DASH_CHARS),
      fc.integer({ min: 0, max: 3 }),
      fc.integer({ min: 0, max: 5 }),
      (surah, rawAyah, dash, rendering, family) => {
        const count = SURAH_AYAH_COUNTS[surah - 1]!;
        const ayah = 1 + (rawAyah % count);
        const second = 1 + (ayah % count);
        const address = `QS. ${surah}:${ayah}`;
        const spans = [
          address,
          `${address}${dash}${ayah}`,
          `${address} ${dash} ${ayah}`,
          `${address}${dash}${second}`,
        ];
        const families: readonly (readonly string[])[] = [
          [address],
          [address, `QS. ${surah}:${second}`],
          [marker],
          [`QS. ${surah}:${second}`],
          [],
          [address, marker],
        ];
        const known = new Set(families[family]!);
        const span = spans[rendering]!;
        const candidate = citationCandidatesIn(`Lihat ${span} ya`)[0]!;
        const verdict = groundingLabelsFor(candidate, known);
        // Every shape in this space begins with the Quran grammar, which declares an
        // address list — the branch that decides a span per address.
        expect(declaresAddressList(candidate), span).toBe(true);
        if (verdict !== null) {
          // (a) every returned label is retrieved — "grounded" is never invented.
          for (const label of verdict) expect(known.has(label), `${span} -> ${label}`).toBe(true);
          // (b) strict-whole: no address the span declares is skipped.
          for (const one of addressesNamedBy(candidate)!) {
            expect(known.has(one), `${span} declares ${one}`).toBe(true);
          }
          // (c) the marker grounds only a span that names the marker.
          if (known.size === 1 && known.has(marker)) {
            expect(candidate, "marker-only retrieved set").toBe(marker);
          }
        }
        // (d) monotonicity in the retrieved set: more context never refuses a
        // citation the gate accepted with less.
        if (verdict !== null) {
          expect(
            groundingLabelsFor(candidate, new Set([...known, address, marker])),
            span,
          ).not.toBeNull();
        }
      },
    );
    expect(fc.assert(property, { numRuns: 400 })).toBeUndefined();
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

  it("still refuses a fabricated citation glued at a STRUCTURAL position (review A3)", () => {
    // The scan side used to read the raw draft, so a format character between
    // `no` and `.` (or between the marker and its address) made the whole
    // citation invisible and a FABRICATED one passed the gate unseen. With the
    // scan reading the stripped text these all refuse; reverting that strip
    // reddens this test deterministically.
    const cases: readonly (readonly [string, string])[] = [
      ["HR. Bukhari no\u200c. 99999", "HR. Bukhari no. 5010"],
      ["HR. Bukhari no\u200d. 99999", "HR. Bukhari no. 5010"],
      ["QS\u200c. 9:99", "QS. 2:255"],
      ["QS. 2:\u200c99", "QS. 2:255"],
      ["QS. 2:\u200b99", "QS. 2:255"],
    ];
    for (const [fabricated, retrieved] of cases) {
      const { grounded, ungrounded } = validateCitations(`Lihat ${fabricated} lanjut`, [
        chunk(retrieved),
      ]);
      expect(ungrounded, fabricated).toEqual([fabricated.replace(/\p{Cf}+/gu, "")]);
      expect(grounded, fabricated).toEqual([]);
    }
  });
});
