import { describe, expect, it } from "vite-plus/test";
import type { Chunk } from "@app/rag-core";
import { canonicalCollectionName } from "./chat-citation-collection";
import { HADITH_COLLECTION_NAMES } from "./hadith-source";
import { normalizeCitationLabel, validateCitations } from "./chat-citation-validator";

/**
 * The fold's contract: a collection name the corpus carries spells one address
 * under every transliteration the product publishes and its readers write, an
 * unrecognised name is untouched, and the fold never reaches the number — so a
 * fabricated address keeps refusing.
 */

function chunk(label: string): Chunk {
  return { id: `c-${label}`, text: "evidence", metadata: { citation: label } };
}

describe("canonicalCollectionName — the spellings one collection compares as", () => {
  it.each([
    ["Bukhari", "Bukhari"],
    ["Sahih Bukhari", "Bukhari"],
    ["Shahih Bukhari", "Bukhari"],
    ["Muslim", "Muslim"],
    ["Sahih Muslim", "Muslim"],
    ["Abu Dawud", "Abu Dawud"],
    ["Abu Daud", "Abu Dawud"],
    ["Sunan Abu Dawud", "Abu Dawud"],
    ["Tirmidhi", "Tirmidhi"],
    ["Tirmidzi", "Tirmidhi"],
    ["At-Tirmidzi", "Tirmidhi"],
    ["Sunan Tirmidzi", "Tirmidhi"],
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
  ])("folds %s to the corpus's own name, %s", (spelling, canonical) => {
    expect(canonicalCollectionName(spelling)).toBe(canonical);
  });

  it("leaves a collection the corpus does not carry exactly as written", () => {
    // The fold is a closed vocabulary, not a fuzzy match: an unknown name keeps
    // its own spelling, so it grounds on no chunk's label and the fabricated
    // citation still refuses.
    for (const unknown of ["Fakebook", "Bukhariy", "Musannaf", "Sahih Sittah"]) {
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

  it("leaves the number and its tail untouched", () => {
    expect(normalizeCitationLabel("HR. Ibnu Majah no. 224 (Dhaif)")).toBe("HR. Ibn Majah no. 224");
    expect(normalizeCitationLabel("HR. Sunan Ibnu Majah no. 224")).toBe("HR. Ibn Majah no. 224");
    expect(normalizeCitationLabel("HR. Ibnu Majah no. 224—225")).toBe("HR. Ibn Majah no. 224—225");
  });
});
