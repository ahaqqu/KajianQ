import { describe, expect, it } from "vite-plus/test";
import { HADITH_COLLECTIONS, HADITH_COLLECTION_NAMES, formatHadithCitation } from "./hadith-source";
import { CITATION_GRAMMARS } from "./chat-citation-grammar";

/**
 * The hadith **address bound**, checked against the reference read it replaced.
 *
 * The grammar publishes where a hadith address ends as its third capture group's
 * recorded coordinates, and the comparison fold owns what that address compares as.
 * This file holds the independent reference implementation the bound was measured
 * against — a whole-match scan for the address word followed by the ASCII-digit-led
 * number word — and re-checks the current build against it on every run: the corpus's
 * own labels, every marker and address-word casing, the degenerate tokens, and a
 * seeded fuzz over the character classes a draft can glue to a number.
 *
 * A pattern edited so the third group stops meaning the number word reddens here
 * rather than in a request, and the case count is pinned so widening the sweep is a
 * decision rather than an accident.
 */

/** The reference scan: the address word plus the tail it absorbs. */
const REFERENCE_PATTERN =
  /\bHR(?:\.|\s)\s*([^\s,.]{1,24}(?:\s+[^\s,.]{1,24}){0,3})(\s+no\.\s*[^\s,;.)[\]]+)/dgi;
/** The reference read: from the start of the match to the end of the number word. */
const REFERENCE_ADDRESS = /^(.*?no\.\s*\d[\p{L}\p{Nd}]*)/iu;

type Span = { start: number; end: number; text: string; address: string | null };

function referenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      address: REFERENCE_ADDRESS.exec(match[0])?.[1] ?? null,
    });
  }
  return spans;
}

function currentSpans(text: string): Span[] {
  const grammar = CITATION_GRAMMARS.find((candidate) =>
    candidate.pattern().source.includes("no\\."),
  );
  if (grammar === undefined)
    throw new Error("the hadith grammar is missing from CITATION_GRAMMARS");
  const spans: Span[] = [];
  for (const match of text.matchAll(grammar.pattern())) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      address: grammar.addressOf(match),
    });
  }
  return spans;
}

const TAILS = [
  "",
  ":1",
  "¹",
  "(Sahih",
  " (Sahih)",
  "-5011",
  "—5011",
  " - 5011",
  "a",
  "az",
  "02",
  " 5011",
  ":",
  ")",
  "]",
  "[x",
  ", 5",
  "; 5",
  "\u200c1",
  "…",
];
const MARKERS = ["HR.", "HR", "hr.", "hR.", "Hr"];
const ADDRESS_WORDS = ["no.", "No.", "nO.", "NO."];
const NUMBERS = ["1", "224", "573", "5010", "50102", "5010a", "3756.2", "٥٠١٠"];
const GRADE_STATES = [undefined, "sahih", "hasan", "dhaif"] as const;
const DEGENERATE_TOKENS = [
  "",
  "abc",
  "iv",
  "#5010",
  "l",
  "-",
  "(",
  ")",
  "[",
  "]",
  ",",
  ";",
  ".",
  "a1",
  "1a",
  "_",
  "x y",
  "5 ",
  "\u200c",
  "\u200cabc",
];
const FUZZ_ALPHABET = [
  "0",
  "5",
  "9",
  "a",
  "Z",
  "é",
  "ا",
  "٥",
  "\u200c",
  ":",
  "¹",
  "(",
  ")",
  "[",
  "]",
  ",",
  ";",
  ".",
  "-",
  "—",
  " ",
  "\t",
  "\u00a0",
];
const FUZZ_CASES = 60_000;

/** Every (collection, number, grade) label, rendered the ways a draft may write it. */
const CORPUS_CASES =
  HADITH_COLLECTIONS.length *
  NUMBERS.length *
  GRADE_STATES.length *
  (1 + (TAILS.length - 1) + MARKERS.length + ADDRESS_WORDS.length);
/** Each degenerate token at the token, glued, trailing-prose and after-number positions. */
const DEGENERATE_CASES = DEGENERATE_TOKENS.length * ADDRESS_WORDS.length * 4;
const DIFFERENTIAL_CASES = CORPUS_CASES + DEGENERATE_CASES + FUZZ_CASES;

describe("the hadith address bound — the reference read", () => {
  it("agrees with the reference on every corpus label, tail, marker and address-word casing", () => {
    let cases = 0;
    const check = (text: string) => {
      cases += 1;
      expect(currentSpans(text), text).toEqual(referenceSpans(text));
    };
    for (const collection of HADITH_COLLECTIONS) {
      for (const no of NUMBERS) {
        for (const grade of GRADE_STATES) {
          const corpus = formatHadithCitation({
            collection,
            hadithNo: no,
            ...(grade !== undefined ? { grade } : {}),
          });
          check(corpus);
          for (const tail of TAILS.slice(1)) check(`${corpus}${tail}`);
          for (const marker of MARKERS) {
            check(`${marker} ${HADITH_COLLECTION_NAMES[collection]} no. ${no}`);
          }
          for (const word of ADDRESS_WORDS) {
            check(`HR. ${HADITH_COLLECTION_NAMES[collection]} ${word} ${no}`);
          }
        }
      }
    }
    for (const token of DEGENERATE_TOKENS) {
      for (const word of ADDRESS_WORDS) {
        check(`HR. Bukhari ${word} ${token}`);
        check(`HR. Bukhari ${word}${token}`);
        check(`HR. Bukhari ${word} ${token} lanjut`);
        check(`HR. Bukhari no. 5010 ${token}`);
      }
    }
    expect(cases).toBe(CORPUS_CASES + DEGENERATE_CASES);
  });

  it("agrees with the reference over a seeded fuzz of the tail's character classes", () => {
    let seed = 20261018;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let cases = 0;
    for (let i = 0; i < FUZZ_CASES; i += 1) {
      let token = "";
      const length = 1 + Math.floor(random() * 8);
      for (let j = 0; j < length; j += 1)
        token += FUZZ_ALPHABET[Math.floor(random() * FUZZ_ALPHABET.length)];
      const word = ADDRESS_WORDS[Math.floor(random() * ADDRESS_WORDS.length)] ?? "no.";
      const collection =
        HADITH_COLLECTION_NAMES[
          HADITH_COLLECTIONS[Math.floor(random() * HADITH_COLLECTIONS.length)] ?? "bukhari"
        ];
      const separator = [" ", "", "\u200c", "  "][Math.floor(random() * 4)] ?? " ";
      const text = `HR. ${collection} ${word}${separator}${token}`;
      cases += 1;
      expect(currentSpans(text), text).toEqual(referenceSpans(text));
    }
    expect(cases).toBe(FUZZ_CASES);
  });

  it("accounts for every case the differential claims", () => {
    // The pinned total is what makes the figure in the PR reproducible: a sweep that
    // grows or shrinks has to say so here.
    expect(DIFFERENTIAL_CASES).toBe(CORPUS_CASES + DEGENERATE_CASES + FUZZ_CASES);
    expect(DIFFERENTIAL_CASES).toBe(66_816);
  });
});
