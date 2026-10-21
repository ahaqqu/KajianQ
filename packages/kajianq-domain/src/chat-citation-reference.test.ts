import { describe, expect, it } from "vite-plus/test";
import { MAX_CITATION_REFERENCES, citationReferencesIn } from "./chat-citation-reference";

/**
 * Citation-reference detection: a question's own label is mapped onto the
 * identity the corpus wrote at ingest, so the retrieval arm can read the row
 * the label addresses. The parser is the citation family's own, so a spelling
 * the gate folds (case, collection aliases, fullwidth digits) is the spelling
 * the lookup reads; a form that names no single stored address is not looked up.
 */

describe("citationReferencesIn", () => {
  it("maps a hadith label onto the collection + number identity the corpus stores", () => {
    expect(citationReferencesIn("Apa isi hadits pada HR. Bukhari no. 4697?")).toEqual([
      {
        label: "HR. Bukhari no. 4697",
        match: { collection: "bukhari", hadithNo: "4697" },
      },
    ]);
  });

  it("maps an ayah label onto the surah + ayah identity", () => {
    expect(citationReferencesIn("Apa makna QS. 2:255?")).toEqual([
      { label: "QS. 2:255", match: { surah: 2, ayah: 255 } },
    ]);
  });

  it("folds a collection alias to the corpus's own collection", () => {
    const references = citationReferencesIn("Jelaskan HR. Sahih al-Bukhari no. 4697.");
    expect(references).toHaveLength(1);
    expect(references[0]?.label).toBe("HR. Bukhari no. 4697");
    expect(references[0]?.match).toEqual({ collection: "bukhari", hadithNo: "4697" });
  });

  it("returns nothing for a question naming no citation", () => {
    expect(citationReferencesIn("Apa isi hadits tentang wudhu?")).toEqual([]);
  });

  it("does not resolve a range: it names no single stored address", () => {
    // The grammar keeps a dash-joined hadith number whole because it cannot
    // enumerate it, and the gate refuses it; the lookup must not pick an endpoint.
    expect(citationReferencesIn("Jelaskan HR. Bukhari no. 5010—5011.")).toEqual([]);
    expect(citationReferencesIn("Jelaskan QS. 2:255-256.")).toEqual([]);
  });

  it("does not resolve a collection the corpus does not carry", () => {
    expect(citationReferencesIn("Jelaskan HR. Fictitious no. 1.")).toEqual([]);
  });

  it("bounds the references one question may spend a lookup on", () => {
    const many = Array.from(
      { length: MAX_CITATION_REFERENCES + 3 },
      (_, i) => `HR. Bukhari no. ${100 + i}`,
    ).join(" ");
    expect(citationReferencesIn(`Bandingkan ${many}.`)).toHaveLength(MAX_CITATION_REFERENCES);
  });
});
