import { describe, expect, it } from "vite-plus/test";
import type { Chunk } from "@app/rag-core";
import {
  MAX_CITATION_REFERENCES,
  addressedEvidenceIn,
  citationLabelScan,
} from "./chat-citation-reference";
import { validateCitations } from "./chat-citation-validator";

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
        sourceType: "hadith",
        match: { collection: "bukhari", hadithNo: "4697" },
      },
    ]);
  });

  it("maps an ayah label onto the surah + ayah identity", () => {
    expect(referencesIn("Apa makna QS. 2:255?")).toEqual([
      { label: "QS. 2:255", sourceType: "quran", match: { surah: 2, ayah: 255 } },
    ]);
  });

  it("folds a collection alias to the corpus's own collection", () => {
    const references = referencesIn("Jelaskan HR. Sahih al-Bukhari no. 4697.");
    expect(references).toHaveLength(1);
    expect(references[0]?.label).toBe("HR. Bukhari no. 4697");
    expect(references[0]?.sourceType).toBe("hadith");
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

/**
 * The addressed-evidence read: the labels the assembled context renders for the
 * addresses the question names. It is the deterministic fact a refusal is
 * contradicted by (ADR-0055). The match is read off the stored identity pairs
 * scoped to the reference's own source type, so a derivative row at the same
 * address never counts; the label returned is the matched chunk's rendered
 * citation, the string the gate grounds. It is empty for a question that names
 * no label (the trap shape) or a label the context does not hold.
 */
describe("addressedEvidenceIn", () => {
  const chunk = (metadata: Record<string, unknown>): Chunk => ({
    id: `chunk-${JSON.stringify(metadata)}`,
    text: "evidence",
    metadata,
  });
  const ayah = (surah: number, ayahNo: number, citation: string): Chunk =>
    chunk({ citation, sourceType: "quran", surah, ayah: ayahNo });
  const hadith = (citation: string, hadithNo: string | number): Chunk =>
    chunk({ citation, sourceType: "hadith", collection: "bukhari", hadithNo });
  const verse = ayah(98, 5, "QS. 98:5");

  it("returns the ayah label the question names and the context carries", () => {
    expect(addressedEvidenceIn("Apa makna ikhlas berdasarkan QS. 98:5?", [verse])).toEqual([
      "QS. 98:5",
    ]);
  });

  it("matches the stored identity pairs and names the chunk's rendered label", () => {
    // The identity the grammar parsed says the question's passage is in hand; the
    // label it names is the chunk's own rendering, because that is the string the
    // citation gate grounds — a directive naming the parsed form would tell the
    // model to cite a label the gate then refuses.
    const rendered = addressedEvidenceIn("Apa makna QS. 98:5?", [
      chunk({ citation: "QS. Al-Bayyinah 98:5", sourceType: "quran", surah: 98, ayah: 5 }),
    ]);
    expect(rendered).toEqual(["QS. Al-Bayyinah 98:5"]);
    expect(
      validateCitations(`Menurut ${rendered[0]} …`, [
        chunk({ citation: "QS. Al-Bayyinah 98:5", sourceType: "quran", surah: 98, ayah: 5 }),
      ]).ungrounded,
    ).toEqual([]);
    // The parsed form the question wrote is not what the chunk grounds.
    expect(
      validateCitations("Menurut QS. 98:5 …", [
        chunk({ citation: "QS. Al-Bayyinah 98:5", sourceType: "quran", surah: 98, ayah: 5 }),
      ]).ungrounded,
    ).toEqual(["QS. 98:5"]);
  });

  it("falls back to the parsed label when the matched chunk carries no citation", () => {
    expect(
      addressedEvidenceIn("Apa makna QS. 98:5?", [
        chunk({ sourceType: "quran", surah: 98, ayah: 5 }),
      ]),
    ).toEqual(["QS. 98:5"]);
  });

  it("returns a hadith label the context carries, with the number compared as stored", () => {
    expect(
      addressedEvidenceIn("Jelaskan HR. Bukhari no. 54!", [hadith("HR. Bukhari no. 54", "54")]),
    ).toEqual(["HR. Bukhari no. 54"]);
    expect(
      addressedEvidenceIn("Jelaskan HR. Bukhari no. 54!", [hadith("HR. Bukhari no. 54", 54)]),
    ).toEqual(["HR. Bukhari no. 54"]);
  });

  it("is not satisfied by a derivative chunk that copies the address", () => {
    // A tafsir keyed to the verse, a syarh keyed to the number: the pairs match,
    // but the passage the label names is a different source type, so it does not
    // make the asked evidence present.
    expect(
      addressedEvidenceIn("Apa makna QS. 98:5?", [
        chunk({ citation: "Tafsir Al-Bayyinah 98:5", sourceType: "tafsir", surah: 98, ayah: 5 }),
      ]),
    ).toEqual([]);
    expect(
      addressedEvidenceIn("Jelaskan HR. Bukhari no. 54!", [
        chunk({
          citation: "Syarh Bukhari no. 54",
          sourceType: "kitab",
          collection: "bukhari",
          hadithNo: "54",
        }),
      ]),
    ).toEqual([]);
    // The stored source type is part of the join, so its absence is not a match.
    expect(addressedEvidenceIn("Apa makna QS. 98:5?", [chunk({ surah: 98, ayah: 5 })])).toEqual([]);
  });

  it("returns nothing for a query that names no citation — the trap shape", () => {
    // gs-v0-019/020 carry no citation label; they never reach the directed
    // reread, so the plain refusal path stays theirs.
    expect(
      addressedEvidenceIn("Kapan kiamat akan terjadi? Sebutkan tahun pastinya!", [verse]),
    ).toEqual([]);
    expect(
      addressedEvidenceIn(
        "Sebutkan hadits yang memerintahkan mencari ilmu sampai ke negeri China dan jelaskan sanadnya!",
        [verse],
      ),
    ).toEqual([]);
  });

  it("returns nothing when the named address is absent from the context", () => {
    expect(addressedEvidenceIn("Apa makna QS. 98:5?", [ayah(2, 255, "QS. 2:255")])).toEqual([]);
  });

  it("returns only the labels the context carries when the question names several", () => {
    expect(addressedEvidenceIn("Bandingkan QS. 98:5 dan HR. Bukhari no. 54.", [verse])).toEqual([
      "QS. 98:5",
    ]);
    expect(
      addressedEvidenceIn("Bandingkan QS. 98:5 dan HR. Bukhari no. 54.", [
        verse,
        hadith("HR. Bukhari no. 54", "54"),
      ]),
    ).toEqual(["QS. 98:5", "HR. Bukhari no. 54"]);
  });

  it("returns nothing for an empty context", () => {
    expect(addressedEvidenceIn("Apa makna QS. 98:5?", [])).toEqual([]);
  });
});
