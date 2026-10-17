import fc from "fast-check";
import { test } from "@fast-check/vitest";
import { describe, expect } from "vite-plus/test";
import {
  HADITH_COLLECTION_ARTICLES,
  HADITH_COLLECTION_SPELLINGS,
  HADITH_COLLECTION_WRAPPERS,
  canonicalCollectionName,
} from "./chat-citation-collection";
import { HADITH_COLLECTION_NAMES } from "./hadith-source";
import { normalizeCitationLabel } from "./chat-citation-validator";

/**
 * The fold's laws, on generated inputs: every spelling of a collection compares
 * as the corpus's own name under every rendering the fold strips, the address's
 * number is left exactly as written, and a name the table does not hold is the
 * identity — the direction that keeps a fabricated collection refusing.
 */

/** A hadith address number word: ASCII-digit-led, letters or digits continuing it. */
const numberWord = fc.stringMatching(/^[1-9][0-9]{0,4}[a-z]?$/);

/** A collection name no row of the vocabulary holds, in either direction. */
const foreignCollection = fc
  .stringMatching(/^[A-Z][a-z]{2,10}$/)
  .filter(
    (name) =>
      !HADITH_COLLECTION_SPELLINGS.some(
        ([spelling]) => spelling.replace(/[^a-z]/gi, "").toLowerCase() === name.toLowerCase(),
      ),
  );

/** One rendering of a spelling: bare, wrapper-prefixed, and wrapper + article. */
const renderedSpelling = fc
  .constantFrom(...HADITH_COLLECTION_SPELLINGS)
  .chain(([spelling, collection]) =>
    fc
      .constantFrom(
        spelling,
        ...HADITH_COLLECTION_WRAPPERS.map((wrapper) => `${wrapper} ${spelling}`),
        ...HADITH_COLLECTION_WRAPPERS.flatMap((wrapper) =>
          HADITH_COLLECTION_ARTICLES.map((article) => `${wrapper} ${article}-${spelling}`),
        ),
      )
      .map((rendering) => [rendering, collection] as const),
  );

describe("canonicalCollectionName — the laws the comparison form depends on", () => {
  test.prop([fc.constantFrom(...HADITH_COLLECTION_SPELLINGS), numberWord])(
    "every spelling folds to the corpus's name, and the number is untouched",
    ([spelling, collection], number) => {
      const canonical = HADITH_COLLECTION_NAMES[collection];
      expect(normalizeCitationLabel(`HR. ${spelling} no. ${number}`)).toBe(
        `HR. ${canonical} no. ${number}`,
      );
    },
  );

  test.prop([renderedSpelling, numberWord])(
    "every rendered form of a spelling folds to the same name, number untouched",
    ([rendering, collection], number) => {
      const canonical = HADITH_COLLECTION_NAMES[collection];
      expect(canonicalCollectionName(rendering)).toBe(canonical);
      expect(normalizeCitationLabel(`HR. ${rendering} no. ${number}`)).toBe(
        `HR. ${canonical} no. ${number}`,
      );
    },
  );

  test.prop([fc.constantFrom(...HADITH_COLLECTION_SPELLINGS)])(
    "folding an already folded spelling is the identity",
    ([spelling, collection]) => {
      const canonical = HADITH_COLLECTION_NAMES[collection];
      expect(canonicalCollectionName(canonical)).toBe(canonical);
      expect(canonicalCollectionName(spelling)).toBe(canonical);
    },
  );

  test.prop([foreignCollection])(
    "a collection the corpus does not carry keeps its own spelling",
    (name) => {
      expect(canonicalCollectionName(name)).toBe(name);
      expect(normalizeCitationLabel(`HR. ${name} no. 12`)).toBe(`HR. ${name} no. 12`);
    },
  );
});
