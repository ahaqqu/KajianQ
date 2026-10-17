import { HADITH_COLLECTION_NAMES, type HadithCollection } from "./hadith-source";

/**
 * The **collection name** a hadith address carries, and the spellings of one
 * collection that compare equal to the corpus's own.
 *
 * The address a hadith grammar identifies includes the collection name
 * (`HADITH_ADDRESS`), so that name is part of identity and must be compared:
 * `HR. Bukhari no. 149` and `HR. Muslim no. 149` are two addresses. Two
 * spellings of **one** collection are not two addresses. The corpus renders one
 * English transliteration per collection (`HADITH_COLLECTION_NAMES`), while the
 * collection list the product publishes and the Indonesian prose its readers
 * and its generator write use others — `Tirmidzi`, `Nasa'i`, `Ibnu Majah`,
 * `Abu Daud` — and the long forms the grammar already tolerates as citations
 * dress the name in the collection-type word or the article the transliteration
 * attaches (`Sunan Abu Dawud`, `Sahih al-Bukhari`, `at-Tirmidhi`, `an-Nasai`). An
 * address naming a known collection under any of those spellings is that
 * collection's address; leaving them unequal refuses a correctly retrieved
 * citation and, through the reviewer's withhold rule, tells the user no evidence
 * exists.
 *
 * The fold is spelling only, and its boundary is what makes it safe:
 *
 * - **the number is never touched**, so a fabricated or near-miss address keeps
 *   refusing (`HR. Ibnu Majah no. 99999` grounds on nothing);
 * - **every key maps onto a collection the corpus carries** — the values are
 *   `HADITH_COLLECTION_NAMES` entries, so the fold can never merge two
 *   collections;
 * - **an unrecognised name is returned exactly as written**, so a collection the
 *   corpus does not hold still has nothing to ground on (`Sunan Tabari` folds to
 *   itself, no row matches, and the address refuses).
 *
 * A second **name** for a collection is added by adding a row, never by loosening
 * the comparison: the fold is a closed vocabulary, not a fuzzy match. The table
 * is exported so a row cannot be added, removed or re-mapped without the tests
 * that read it failing.
 */
export const HADITH_COLLECTION_SPELLINGS: readonly (readonly [string, HadithCollection])[] = [
  ["bukhari", "bukhari"],
  ["muslim", "muslim"],
  ["abu dawud", "abudawud"],
  ["abu daud", "abudawud"],
  ["tirmidhi", "tirmidhi"],
  ["tirmidzi", "tirmidhi"],
  ["nasai", "nasai"],
  ["ibn majah", "ibnmajah"],
  ["ibnu majah", "ibnmajah"],
  ["malik", "malik"],
];

/**
 * The words a rendering may put **in front of** a collection without naming a
 * different one: the collection-type word (`Sunan Abu Dawud` is Abu Dawud's
 * Sunan), the honorific, and the Arabic article the transliteration attaches
 * (`at-Tirmidhi`, `an-Nasai`, `al-Bukhari`). A rule over the whole vocabulary
 * rather than a row per combination, so `Sunan <collection>` folds for every
 * collection the corpus carries — which is what lets a test generate the forms.
 * A name is never dropped by it: what is left after the wrappers still has to be
 * a row.
 */
export const HADITH_COLLECTION_WRAPPERS: readonly string[] = [
  "sunan",
  "shahih",
  "sahih",
  "muwatta",
  "imam",
];
export const HADITH_COLLECTION_ARTICLES: readonly string[] = ["al", "an", "at"];

/**
 * The spellings compare in a punctuation-free lower case: the apostrophes
 * Indonesian prose writes a transliteration with (`Nasa'i`, `Nasa’i`) carry no
 * name, and a hyphen or space between the same words is one name either way
 * (`at-Tirmidhi` / `At Tirmidhi`). The wrappers above come off here, so a row is
 * written as the bare name it maps from.
 */
function spellingKey(collection: string): string {
  const key = collection
    .replace(/['’‘`´]/g, "")
    .replace(/[-\u2010-\u2015]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return bareName(key);
}

/** `key` with every leading wrapper or attached article removed. */
function bareName(key: string): string {
  let bare = key;
  for (;;) {
    const wrapper = [...HADITH_COLLECTION_WRAPPERS, ...HADITH_COLLECTION_ARTICLES].find((word) =>
      bare.startsWith(`${word} `),
    );
    if (wrapper === undefined) return bare;
    bare = bare.slice(wrapper.length + 1);
  }
}

const COLLECTION_BY_SPELLING = new Map<string, HadithCollection>(
  HADITH_COLLECTION_SPELLINGS.map(([spelling, collection]) => [spellingKey(spelling), collection]),
);

/**
 * The corpus's own name for the collection a label spells, or the label's own
 * spelling unchanged when it names no collection the corpus carries. Pure and
 * idempotent: folding an already-canonical name returns it.
 */
export function canonicalCollectionName(collection: string): string {
  const collectionId = COLLECTION_BY_SPELLING.get(spellingKey(collection));
  return collectionId === undefined ? collection : HADITH_COLLECTION_NAMES[collectionId];
}
