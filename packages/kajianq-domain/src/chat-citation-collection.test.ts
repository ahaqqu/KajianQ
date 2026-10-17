import { describe, expect, it } from "vite-plus/test";
import type { Chunk } from "@app/rag-core";
import {
  HADITH_COLLECTION_ARTICLES,
  HADITH_COLLECTION_SPELLINGS,
  HADITH_COLLECTION_WRAPPERS,
  canonicalCollectionName,
} from "./chat-citation-collection";
import { HADITH_COLLECTION_NAMES } from "./hadith-source";
import {
  citationMatchText,
  normalizeCitationLabel,
  validateCitations,
} from "./chat-citation-validator";

/**
 * The fold's contract: a collection name the corpus carries spells one address
 * under every transliteration the product publishes and its readers write, an
 * unrecognised name is untouched, and the fold never reaches the number — so a
 * fabricated address keeps refusing.
 */

function chunk(label: string): Chunk {
  return { id: `c-${label}`, text: "evidence", metadata: { citation: label } };
}

/**
 * The names the fold must carry, written out by hand: the vocabulary's semantic
 * declaration, which {@link HADITH_COLLECTION_SPELLINGS} is checked against row
 * for row — so a row cannot be re-mapped to another collection unseen.
 */
const DECLARED_COLLECTION_SPELLINGS: readonly (readonly [string, string])[] = [
  ["Bukhari", "Bukhari"],
  ["Muslim", "Muslim"],
  ["Abu Dawud", "Abu Dawud"],
  ["Abu Daud", "Abu Dawud"],
  ["Tirmidhi", "Tirmidhi"],
  ["Tirmidzi", "Tirmidhi"],
  ["Nasai", "Nasai"],
  ["Ibn Majah", "Ibn Majah"],
  ["Ibnu Majah", "Ibn Majah"],
  ["Malik", "Malik"],
];

/**
 * One rendering of a name per wrapper word and per article: the declaration the
 * generated forms are bound to, so a wrapper added to the fold without a
 * hand-written meaning here fails the coverage test below.
 */
const DECLARED_COLLECTION_RENDERINGS: readonly (readonly [string, string])[] = [
  ["Bukhari", "Bukhari"],
  ["Sahih Bukhari", "Bukhari"],
  ["Shahih Bukhari", "Bukhari"],
  ["Sahih al-Bukhari", "Bukhari"],
  ["Muslim", "Muslim"],
  ["Sahih Muslim", "Muslim"],
  ["Abu Dawud", "Abu Dawud"],
  ["Abu Daud", "Abu Dawud"],
  ["Sunan Abu Dawud", "Abu Dawud"],
  ["Tirmidhi", "Tirmidhi"],
  ["Tirmidzi", "Tirmidhi"],
  ["At-Tirmidzi", "Tirmidhi"],
  ["Sunan Tirmidzi", "Tirmidhi"],
  ["Sunan at-Tirmidzi", "Tirmidhi"],
  ["Nasai", "Nasai"],
  ["Nasa'i", "Nasai"],
  ["Nasa’i", "Nasai"],
  ["An-Nasa'i", "Nasai"],
  ["Sunan an-Nasa'i", "Nasai"],
  ["Ibn Majah", "Ibn Majah"],
  ["Ibnu Majah", "Ibn Majah"],
  ["Sunan Ibnu Majah", "Ibn Majah"],
  ["Malik", "Malik"],
  ["Muwatta Malik", "Malik"],
  ["Imam Malik", "Malik"],
];

describe("canonicalCollectionName — the spellings one collection compares as", () => {
  it("declares the vocabulary the fold carries, row for row", () => {
    // A row's key is written lower case by construction; the declaration is
    // prose, so the two meet on the same fold.
    const carried = HADITH_COLLECTION_SPELLINGS.map(([spelling, collection]) => [
      spelling.toLowerCase(),
      HADITH_COLLECTION_NAMES[collection],
    ]);
    expect(carried.sort()).toEqual(
      DECLARED_COLLECTION_SPELLINGS.map(([spelling, canonical]) => [
        spelling.toLowerCase(),
        canonical,
      ]).sort(),
    );
  });

  it("resolves every row through one key — no row shadows another", () => {
    for (const [spelling, collection] of HADITH_COLLECTION_SPELLINGS) {
      expect(canonicalCollectionName(spelling)).toBe(HADITH_COLLECTION_NAMES[collection]);
    }
  });

  it("declares a rendering for every wrapper and article the fold strips", () => {
    for (const word of [...HADITH_COLLECTION_WRAPPERS, ...HADITH_COLLECTION_ARTICLES]) {
      const declared = DECLARED_COLLECTION_RENDERINGS.some(([rendering]) => {
        const tokens = rendering.toLowerCase().split(/[\s-]+/);
        return tokens.includes(word) && tokens.at(-1) !== word;
      });
      expect({ word, declared }).toEqual({ word, declared: true });
    }
  });

  it.each(DECLARED_COLLECTION_RENDERINGS)(
    "folds %s to the corpus's own name, %s",
    (spelling, canonical) => {
      expect(canonicalCollectionName(spelling)).toBe(canonical);
    },
  );

  it("leaves a collection the corpus does not carry exactly as written", () => {
    // The fold is a closed vocabulary, not a fuzzy match: an unknown name keeps
    // its own spelling, so it grounds on no chunk's label and the fabricated
    // citation still refuses.
    for (const unknown of ["Fakebook", "Bukhariy", "Musannaf", "Sahih Sittah", "Sunan Tabari"]) {
      expect(canonicalCollectionName(unknown)).toBe(unknown);
    }
  });

  it("is idempotent over every canonical name", () => {
    for (const name of Object.values(HADITH_COLLECTION_NAMES)) {
      expect(canonicalCollectionName(name)).toBe(name);
      expect(canonicalCollectionName(canonicalCollectionName(name))).toBe(name);
    }
  });
});

describe("the collection fold is spelling only", () => {
  it("grounds a transliterated collection name against the corpus's label", () => {
    // The Golden Set's requirement and the corpus's label of the SAME hadith
    // differ only in the collection's transliteration: the answer that quotes
    // the retrieved evidence cites the corpus spelling.
    expect(normalizeCitationLabel("HR. Ibnu Majah no. 224")).toBe(
      normalizeCitationLabel("HR. Ibn Majah no. 224 (Dhaif)"),
    );
  });

  it("grounds a citation whose collection the draft wrote with an apostrophe", () => {
    // The reviewer withholds an answer whose citation grounds on no retrieved
    // label, so a spelling the product's own collection list publishes must
    // ground or an answer that quotes the evidence it was given is refused.
    const { grounded, ungrounded } = validateCitations("Lihat HR. Nasa’i no. 592 tentang safar.", [
      chunk("HR. Nasai no. 592 (Sahih)"),
    ]);
    expect(ungrounded).toEqual([]);
    expect(grounded).toEqual(["HR. Nasai no. 592"]);
  });

  it("still refuses a fabricated number under a folded collection name", () => {
    const { ungrounded } = validateCitations("HR. Ibnu Majah no. 99999 disebutkan …", [
      chunk("HR. Ibn Majah no. 224 (Dhaif)"),
    ]);
    expect(ungrounded).toEqual(["HR. Ibn Majah no. 99999"]);
  });

  it("still refuses a fabricated collection name", () => {
    const { ungrounded } = validateCitations("HR. Fakebook no. 224 disebutkan …", [
      chunk("HR. Ibn Majah no. 224 (Dhaif)"),
    ]);
    expect(ungrounded).toEqual(["HR. Fakebook no. 224"]);
  });

  it("does not merge two collections that carry the same number", () => {
    const { ungrounded } = validateCitations("HR. Muslim no. 224 disebutkan …", [
      chunk("HR. Ibn Majah no. 224 (Dhaif)"),
    ]);
    expect(ungrounded).toEqual(["HR. Muslim no. 224"]);
  });

  it("grounds a collection the scan read in a casing the corpus does not use", () => {
    // The grammars match case-insensitively, so a span they read is a citation: a
    // marker or address word in another casing is not a different address, and
    // refusing it would refuse the very label the chunk carries.
    for (const [draft, label] of [
      ["hr. Ibnu Majah no. 224 disebutkan …", "HR. Ibn Majah no. 224 (Dhaif)"],
      ["HR. Bukhari No. 5010 tentang …", "HR. Bukhari no. 5010"],
      ["ayat kursi qs. 2:255", "QS. 2:255"],
    ] as const) {
      const { grounded, ungrounded } = validateCitations(draft, [chunk(label)]);
      expect({ draft, grounded, ungrounded }).toEqual({
        draft,
        grounded: [normalizeCitationLabel(label)],
        ungrounded: [],
      });
    }
  });

  it("does not fold a spelling the scan cannot read", () => {
    // The other direction: folding is bounded by what the grammar reads, so a
    // spelling it excludes is never rewritten into a label that grounds.
    const excluded = "HRIbnu Majah no. 224 disebutkan";
    expect(citationMatchText(excluded)).toBe(excluded);
    expect(validateCitations(excluded, [chunk("HR. Ibn Majah no. 224 (Dhaif)")])).toEqual({
      grounded: [],
      ungrounded: [],
    });
    const fabricated = validateCitations("hr. Ibnu Majah no. 99999 disebutkan", [
      chunk("HR. Ibn Majah no. 224 (Dhaif)"),
    ]);
    expect(fabricated.ungrounded).toEqual(["HR. Ibn Majah no. 99999"]);
  });

  it("leaves the number and its tail untouched", () => {
    expect(normalizeCitationLabel("HR. Ibnu Majah no. 224 (Dhaif)")).toBe("HR. Ibn Majah no. 224");
    expect(normalizeCitationLabel("HR. Sunan Ibnu Majah no. 224")).toBe("HR. Ibn Majah no. 224");
    expect(normalizeCitationLabel("HR. Ibnu Majah no. 224—225")).toBe("HR. Ibn Majah no. 224—225");
  });
});
