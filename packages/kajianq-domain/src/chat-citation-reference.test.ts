import { describe, expect, it } from "vite-plus/test";
import { MAX_CITATION_REFERENCES, citationLabelScan } from "./chat-citation-reference";

/** The read list alone — what the lookup would spend its reads on. */
const referencesIn = (text: string) => citationLabelScan(text).references;

/**
 * Citation-reference detection: a question's own label is mapped onto the
 * identity the corpus wrote at ingest, so the retrieval arm can read the row
 * the label addresses. The parser is the citation family's own, so a spelling
 * the gate folds (case, collection aliases, fullwidth digits) is the spelling
 * the lookup reads; a form that names no single stored address is not looked up.
 */

describe("citationReferencesIn", () => {
  it("maps a hadith label onto the collection + number identity the corpus stores", () => {
    expect(referencesIn("Apa isi hadits pada HR. Bukhari no. 4697?")).toEqual([
      {
        label: "HR. Bukhari no. 4697",
        match: { collection: "bukhari", hadithNo: "4697" },
      },
    ]);
  });

  it("maps an ayah label onto the surah + ayah identity", () => {
    expect(referencesIn("Apa makna QS. 2:255?")).toEqual([
      { label: "QS. 2:255", match: { surah: 2, ayah: 255 } },
    ]);
  });

  it("folds a collection alias to the corpus's own collection", () => {
    const references = referencesIn("Jelaskan HR. Sahih al-Bukhari no. 4697.");
    expect(references).toHaveLength(1);
    expect(references[0]?.label).toBe("HR. Bukhari no. 4697");
    expect(references[0]?.match).toEqual({ collection: "bukhari", hadithNo: "4697" });
  });

  it("returns nothing for a question naming no citation", () => {
    expect(referencesIn("Apa isi hadits tentang wudhu?")).toEqual([]);
  });

  it("does not resolve a range: it names no single stored address", () => {
    // The grammar keeps a dash-joined hadith number whole because it cannot
    // enumerate it, and the gate refuses it; the lookup must not pick an endpoint.
    expect(referencesIn("Jelaskan HR. Bukhari no. 5010—5011.")).toEqual([]);
    expect(referencesIn("Jelaskan QS. 2:255-256.")).toEqual([]);
  });

  it("records every declined range as seen and unresolved, naming the whole form", () => {
    // A seen form and no label at all are different states: the dropped record is
    // what keeps "named nothing" and "deliberately did not resolve" apart.
    expect(citationLabelScan("Jelaskan HR. Bukhari no. 5010—5011.")).toEqual({
      references: [],
      dropped: [{ label: "HR. Bukhari no. 5010—5011", reason: "range" }],
    });
    expect(citationLabelScan("Jelaskan QS. 2:255-256.")).toEqual({
      references: [],
      dropped: [{ label: "QS. 2:255-256", reason: "range" }],
    });
  });

  it("declines a range or list the grammar left outside its span, never its head", () => {
    // The token stops at whitespace or a comma, so the head alone is
    // indistinguishable from a single address. The continuation proves the form
    // is not one address; the lookup declines the whole form and records it.
    expect(citationLabelScan("Jelaskan HR. Bukhari no. 5010 — 5011.")).toEqual({
      references: [],
      dropped: [{ label: "HR. Bukhari no. 5010 — 5011", reason: "range" }],
    });
    expect(citationLabelScan("Bandingkan HR. Bukhari no. 191, 192, 193.")).toEqual({
      references: [],
      dropped: [{ label: "HR. Bukhari no. 191, 192, 193", reason: "list" }],
    });
    expect(citationLabelScan("Bandingkan HR. Bukhari no. 191 dan 192.")).toEqual({
      references: [],
      dropped: [{ label: "HR. Bukhari no. 191 dan 192", reason: "list" }],
    });
  });

  it("does not resolve a collection the corpus does not carry", () => {
    expect(referencesIn("Jelaskan HR. Fictitious no. 1.")).toEqual([]);
    expect(citationLabelScan("Jelaskan HR. Fictitious no. 1.").dropped).toEqual([
      { label: "HR. Fictitious no. 1", reason: "collection" },
    ]);
  });

  it("records a form no parser reduces to one stored address as unparsed", () => {
    expect(citationLabelScan("Jelaskan QS. Al-Baqarah:255.").dropped).toEqual([
      { label: "QS. Al-Baqarah:255", reason: "unparsed" },
    ]);
  });

  it("bounds the references one question may spend a lookup on", () => {
    const many = Array.from(
      { length: MAX_CITATION_REFERENCES + 3 },
      (_, i) => `HR. Bukhari no. ${100 + i}`,
    ).join(" ");
    const scan = citationLabelScan(`Bandingkan ${many}.`);
    expect(scan.references).toHaveLength(MAX_CITATION_REFERENCES);
    // The over-budget spans are named too, so a budget cut never reads as a
    // question that named only four labels.
    expect(scan.dropped).toEqual([
      { label: "HR. Bukhari no. 104", reason: "budget" },
      { label: "HR. Bukhari no. 105", reason: "budget" },
      { label: "HR. Bukhari no. 106", reason: "budget" },
    ]);
  });
});
