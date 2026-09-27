import { describe, expect, it } from "vitest";
import type { Chunk } from "@app/rag-core";
import {
  citationCandidatesIn,
  citationLabelsOf,
  citationSpansIn,
  normalizeCitationLabel,
  validateCitations,
} from "./chat-citation-validator";

/**
 * The deterministic citation validator (the #10 trust invariant). These tests
 * are the adversarial half of the suite: they name the fabrication shapes a
 * model actually produces and prove each one is caught. A weakening of any
 * assertion here is a silent trust regression — the failure mode is a
 * fabricated religious citation delivered as an answer.
 */

/** A retrieved chunk carrying one citation label. */
function chunk(label: string, extra: Record<string, unknown> = {}): Chunk {
  return { id: `c-${label}`, text: "evidence", metadata: { citation: label, ...extra } };
}

describe("validateCitations — grounded direction", () => {
  it("reports a retrieved label the answer cites", () => {
    const { grounded, ungrounded } = validateCitations("Menurut QS. 2:255 …", [chunk("QS. 2:255")]);
    expect(grounded).toEqual(["QS. 2:255"]);
    expect(ungrounded).toEqual([]);
  });

  it("treats a bracketed citation as the same citation as its prose form", () => {
    const { grounded, ungrounded } = validateCitations("Menurut [QS. 2:255] …", [
      chunk("QS. 2:255"),
    ]);
    expect(grounded).toEqual(["QS. 2:255"]);
    expect(ungrounded).toEqual([]);
  });

  it("tolerates whitespace reflow in the answer", () => {
    const { ungrounded } = validateCitations("Lihat QS.  2:255  ya", [chunk("QS. 2:255")]);
    expect(ungrounded).toEqual([]);
  });

  it("counts a known address extended with a grade suffix as grounded", () => {
    // The chunk's label carries no grade; the model added one. The address is
    // what must be grounded, so this is not a fabrication.
    const { ungrounded } = validateCitations("HR. Bukhari no. 573 (Sahih) menjelaskan …", [
      chunk("HR. Bukhari no. 573"),
    ]);
    expect(ungrounded).toEqual([]);
  });

  it("ignores markdown emphasis wrapped around a citation", () => {
    // Regression, found on the first live size-5 smoke: the hadith grammar stops
    // at sentence punctuation but not at `*`, so `**HR. Malik no. 18**` reached
    // the comparison with its markers attached, was reported ungrounded, and the
    // deterministic gate refused a correctly grounded answer (gs-v0-015).
    const { grounded, ungrounded } = validateCitations(
      "Menurut **HR. Malik no. 18**, puasa dalam perjalanan …",
      [chunk("HR. Malik no. 18")],
    );
    expect(grounded).toEqual(["HR. Malik no. 18"]);
    expect(ungrounded).toEqual([]);
  });

  it("grounds a hadith citation written with an introducing colon (#253)", () => {
    // The false refusal that opened #253: a staging smoke destroyed a
    // correctly retrieved, correctly cited answer because the draft wrote
    // `… HR. Bukhari no. 5010: <matn> …`. The hadith grammar's number token
    // stops at `;`, `.`, `)` and `]` but absorbs `:`, so the label reached the
    // membership test colon-suffixed, no chunk grounded it, and the reviewer
    // rendered the canonical "no evidence" refusal (trace f417d603-…, chunk
    // 94d2a731-… carried the plain label).
    const { grounded, ungrounded } = validateCitations(
      "Rasulullah bersabda dalam HR. Bukhari no. 5010: <matn>",
      [chunk("HR. Bukhari no. 5010")],
    );
    expect(grounded).toEqual(["HR. Bukhari no. 5010"]);
    expect(ungrounded).toEqual([]);
  });

  // The #253 CLASS, not the one character: every punctuation a generator
  // plausibly attaches to a citation's tail. Both labels below are retrieved,
  // so any `ungrounded` entry in this table is the same false refusal that
  // destroyed the gs-v0-001 answer — a grounded citation reported fabricated.
  it.each([
    ["introducing colon", "Rasulullah bersabda dalam HR. Bukhari no. 5010: matn"],
    ["semicolon", "Rasulullah bersabda dalam HR. Bukhari no. 5010; lalu ia bersabda"],
    ["comma", "Rasulullah bersabda dalam HR. Bukhari no. 5010, lalu ia bersabda"],
    ["full stop", "Rasulullah bersabda dalam HR. Bukhari no. 5010. Lalu ia bersabda"],
    ["closing parenthesis", "Rasulullah bersabda dalam (HR. Bukhari no. 5010) lalu ia bersabda"],
    ["closing bracket", "Rasulullah bersabda dalam [HR. Bukhari no. 5010] lalu ia bersabda"],
    ["closed-up em dash", "Rasulullah bersabda dalam HR. Bukhari no. 5010—ia bersabda"],
    ["spaced em dash", "Rasulullah bersabda dalam HR. Bukhari no. 5010 — ia bersabda"],
    ["ellipsis", "Rasulullah bersabda dalam HR. Bukhari no. 5010… lalu ia bersabda"],
    ["closing quote", 'Rasulullah bersabda dalam "HR. Bukhari no. 5010" lalu ia bersabda'],
    ["bold markers", "Rasulullah bersabda dalam **HR. Bukhari no. 5010** lalu ia bersabda"],
    ["bold markers then a colon", "Rasulullah bersabda dalam **HR. Bukhari no. 5010**: matn"],
    ["colon after the Quran address", "Ayat Kursi ada di QS. 2:255: ayat yang agung"],
  ])("grounds a citation whose tail is a %s", (_variant, draft) => {
    const { ungrounded } = validateCitations(draft, [
      chunk("HR. Bukhari no. 5010"),
      chunk("QS. 2:255"),
    ]);
    expect(ungrounded).toEqual([]);
  });

  it("grounds a bracketed hadith citation (#11 regression)", () => {
    // The hadith number token used to eat the closing bracket: `[HR. Malik
    // no. 18]` produced a phantom `HR. Malik no. 18]` candidate that no chunk
    // grounds, so the gate refused a correctly grounded answer. Found by the
    // citation-payload derivation (#11), which resolves these same spans.
    const { grounded, ungrounded } = validateCitations("Hadits [HR. Malik no. 18] berbunyi …", [
      chunk("HR. Malik no. 18"),
    ]);
    expect(grounded).toEqual(["HR. Malik no. 18"]);
    expect(ungrounded).toEqual([]);
  });

  it("grounds a dot-less Quran citation against its dotted label", () => {
    // Round-3 A1: `QS 2:255` is a common model spelling. The grammar must see
    // it (the old dotted-only grammar missed it entirely) and normalization
    // must match it to the chunk's dotted label — a grounded answer must not
    // be refused for the spelling of its marker.
    const { grounded, ungrounded } = validateCitations("Menurut QS 2:255 …", [chunk("QS. 2:255")]);
    expect(grounded).toEqual(["QS. 2:255"]);
    expect(ungrounded).toEqual([]);
  });

  it("grounds a dot-less hadith citation against its dotted label", () => {
    const { grounded, ungrounded } = validateCitations("HR Bukhari no. 573 menyebutkan …", [
      chunk("HR. Bukhari no. 573"),
    ]);
    expect(grounded).toEqual(["HR. Bukhari no. 573"]);
    expect(ungrounded).toEqual([]);
  });

  it("still refuses a fabricated address written in bold", () => {
    // The emphasis stripping must not turn the trap case into a pass.
    const { ungrounded } = validateCitations("**HR. Bukhari no. 99999** menyebutkan …", [
      chunk("HR. Bukhari no. 573"),
    ]);
    expect(ungrounded).toEqual(["HR. Bukhari no. 99999"]);
  });

  it("reads multiple labels from one chunk's metadata array", () => {
    const c: Chunk = { id: "x", text: "t", metadata: { citation: ["QS. 1:1", "QS. 1:2"] } };
    expect(citationLabelsOf(c)).toEqual(["QS. 1:1", "QS. 1:2"]);
    expect(validateCitations("QS. 1:2 saja", [c]).ungrounded).toEqual([]);
  });

  it("returns no labels for a chunk without a citation", () => {
    expect(citationLabelsOf({ id: "x", text: "t" })).toEqual([]);
    expect(citationLabelsOf({ id: "x", text: "t", metadata: { citation: "   " } })).toEqual([]);
  });
});

describe("validateCitations — ungrounded direction (the trap cases)", () => {
  it("catches a fabricated Quran citation in prose", () => {
    const { ungrounded } = validateCitations("Allah berfirman dalam QS. 9:99 tentang hal ini.", [
      chunk("QS. 2:255"),
    ]);
    expect(ungrounded).toEqual(["QS. 9:99"]);
  });

  it("catches a fabricated Quran citation in brackets", () => {
    const { ungrounded } = validateCitations("… [QS. 9:99]", [chunk("QS. 2:255")]);
    expect(ungrounded).toEqual(["QS. 9:99"]);
  });

  it("catches a fabricated Quran citation written without the trailing dot", () => {
    // Round-3 A1: `QS 9:99` (dot-less) previously matched no grammar at all,
    // so a common spelling of a fabricated citation bypassed the gate.
    const { ungrounded } = validateCitations("Allah berfirman dalam QS 9:99 tentang hal ini.", [
      chunk("QS. 2:255"),
    ]);
    expect(ungrounded).toEqual(["QS. 9:99"]);
  });

  it("catches a fabricated hadith written without the trailing dot", () => {
    const { ungrounded } = validateCitations("HR Bukhari no. 99999 menyebutkan …", [
      chunk("HR. Bukhari no. 573"),
    ]);
    expect(ungrounded).toEqual(["HR. Bukhari no. 99999"]);
  });

  it("catches a fabricated hadith number", () => {
    const { ungrounded } = validateCitations("HR. Bukhari no. 99999 menyebutkan …", [
      chunk("HR. Bukhari no. 573"),
    ]);
    expect(ungrounded).toEqual(["HR. Bukhari no. 99999"]);
  });

  it("catches a fabricated hadith written with a long collection name", () => {
    // Thermo-review A2: models write the full collection form ("Sunan Abu
    // Dawud"), which the original two-token grammar missed entirely — the
    // fabricated citation sailed through the gate.
    const { ungrounded } = validateCitations("HR. Sunan Abu Dawud no. 99999 menyebutkan …", [
      chunk("HR. Abu Dawud no. 573"),
    ]);
    expect(ungrounded).toEqual(["HR. Sunan Abu Dawud no. 99999"]);
  });

  it("catches a fabricated hadith whose collection name is written with spaces", () => {
    // The hyphenated `an-Nasai` matched the old grammar by luck; the spaced
    // form did not.
    const { ungrounded } = validateCitations("HR. Sunan an Nasai no. 99999 …", [
      chunk("HR. Bukhari no. 573"),
    ]);
    expect(ungrounded).toEqual(["HR. Sunan an Nasai no. 99999"]);
  });

  it("catches a fabricated Quran citation written with the dotted Q.S. marker", () => {
    // Thermo-review A2: `Q.S. n:n` is a common spelling in Indonesian
    // religious prose and was not part of the grammar at all.
    const { ungrounded } = validateCitations("Allah berfirman dalam Q.S. 9:99 tentang hal ini.", [
      chunk("QS. 2:255"),
    ]);
    expect(ungrounded).toEqual(["QS. 9:99"]);
  });

  it("catches a same-address citation with the WRONG number (near-miss fabrication)", () => {
    // The dangerous case: right collection, invented number.
    const { grounded, ungrounded } = validateCitations("HR. Bukhari no. 574 …", [
      chunk("HR. Bukhari no. 573"),
    ]);
    expect(grounded).toEqual([]);
    expect(ungrounded).toEqual(["HR. Bukhari no. 574"]);
  });

  it("catches a fabricated citation when retrieval returned nothing at all", () => {
    const { ungrounded } = validateCitations("QS. 2:255 menjelaskan …", []);
    expect(ungrounded).toEqual(["QS. 2:255"]);
  });

  it("catches every fabricated citation, not just the first", () => {
    const { ungrounded } = validateCitations("QS. 9:99 dan QS. 8:88 dan HR. Muslim no. 77777", [
      chunk("QS. 2:255"),
    ]);
    expect(ungrounded).toContain("QS. 9:99");
    expect(ungrounded).toContain("QS. 8:88");
    expect(ungrounded).toContain("HR. Muslim no. 77777");
  });

  it("catches a multi-word collection name that is not in the corpus", () => {
    const { ungrounded } = validateCitations("HR. Abu Dawud no. 1 …", []);
    expect(ungrounded).toEqual(["HR. Abu Dawud no. 1"]);
  });

  it("treats a surah-name citation as unverifiable and therefore ungrounded", () => {
    // The corpus's labels are numeric; a name cannot be checked, and the safe
    // direction is a refusal rather than a wave-through.
    const { ungrounded } = validateCitations("QS. Al-Baqarah:255 …", [chunk("QS. 2:255")]);
    expect(ungrounded).toEqual(["QS. Al-Baqarah:255"]);
  });

  it("catches a Kitab citation (no kitab ingestion has landed)", () => {
    const { ungrounded } = validateCitations("Al-Umm, Imam Syafi'i, Jilid 1, Hal. 102", []);
    expect(ungrounded).toEqual(["Jilid 1, Hal. 102"]);
  });

  it("still rejects a fabricated hadith number written with a trailing colon (#253 trap)", () => {
    // The colon fix must strip punctuation, never the address: the number is
    // what makes a citation grounded, and `99999` is in no retrieved chunk.
    const { grounded, ungrounded } = validateCitations(
      "Rasulullah bersabda dalam HR. Bukhari no. 99999: matn",
      [chunk("HR. Bukhari no. 5010")],
    );
    expect(grounded).toEqual([]);
    expect(ungrounded).toEqual(["HR. Bukhari no. 99999"]);
  });

  it("still rejects a near-miss hadith number written with a trailing colon", () => {
    // The dangerous near-miss: right collection, one digit off. Trailing
    // punctuation must not let the number itself be dropped.
    const { ungrounded } = validateCitations("HR. Bukhari no. 5011: matn", [
      chunk("HR. Bukhari no. 5010"),
    ]);
    expect(ungrounded).toEqual(["HR. Bukhari no. 5011"]);
  });

  it("still rejects a closed-up hadith range whose second address was not retrieved", () => {
    // The em-dash rule cuts a dash joined to prose, never to more address
    // digits: a range keeps both addresses, so the unretrieved one is caught.
    const { ungrounded } = validateCitations("HR. Bukhari no. 5010—5011 menjelaskan …", [
      chunk("HR. Bukhari no. 5010"),
    ]);
    expect(ungrounded).toEqual(["HR. Bukhari no. 5010—5011"]);
  });

  it("de-duplicates a citation repeated in the answer", () => {
    const { ungrounded } = validateCitations("QS. 9:99 … lalu QS. 9:99 lagi", []);
    expect(ungrounded).toEqual(["QS. 9:99"]);
  });
});

describe("validateCitations — false-positive guards (good answers stay answers)", () => {
  it("ignores a bracketed non-citation marker", () => {
    // The dhaif warning uses brackets; treating it as a citation would convert
    // every dhaif answer into a refusal.
    const { ungrounded } = validateCitations("Hadits ini dhaif.\n\n[Peringatan] Hadits lemah.", [
      chunk("HR. Ibnu Majah no. 224"),
    ]);
    expect(ungrounded).toEqual([]);
  });

  it("ignores bare numbers and ordinary prose", () => {
    const { ungrounded } = validateCitations(
      "Ada 255 ayat dalam surah ini, dan 2 di antaranya …",
      [],
    );
    expect(ungrounded).toEqual([]);
  });

  it("ignores an unrelated HR. mention without a number", () => {
    const { ungrounded } = validateCitations("HR. department said nothing.", []);
    expect(ungrounded).toEqual([]);
  });

  it("ignores a surah:ayah-shaped span that lacks the QS. marker", () => {
    const { ungrounded } = validateCitations("Lihat 2:255 untuk konteks.", []);
    expect(ungrounded).toEqual([]);
  });
});

describe("citationCandidatesIn", () => {
  it("finds candidates in first-appearance order, de-duplicated", () => {
    expect(citationCandidatesIn("QS. 2:255 then HR. Bukhari no. 1 then QS. 2:255")).toEqual([
      "QS. 2:255",
      "HR. Bukhari no. 1",
    ]);
  });

  it("is order-independent across repeated calls (no shared regex state)", () => {
    const text = "QS. 1:1 and QS. 2:2";
    expect(citationCandidatesIn(text)).toEqual(citationCandidatesIn(text));
  });

  it("leaves clean labels exactly as they are (#253 tail-normalization check)", () => {
    // The other reader must not drift: the citations frame and the reviewer
    // pre-gate key on these labels, and the addresses inside them are
    // untouched by the tail fix.
    expect(citationCandidatesIn("QS. 2:255 dan HR. Bukhari no. 4697 lalu")).toEqual([
      "QS. 2:255",
      "HR. Bukhari no. 4697",
    ]);
  });

  it("keeps two adjacent citations as two spans, in text order (#253)", () => {
    // A colon tail must not merge neighbouring spans: the reviewer pre-gate
    // masks by offsets, and each citation keeps its own claim.
    expect(citationSpansIn("QS. 2:255: HR. Bukhari no. 4697 lalu")).toEqual([
      { start: 0, end: 9, label: "QS. 2:255" },
      { start: 11, end: 31, label: "HR. Bukhari no. 4697" },
    ]);
  });

  it("de-duplicates the same address written with and without its tail (#253)", () => {
    const draft = "HR. Bukhari no. 4697: pertama, HR. Bukhari no. 4697 kedua";
    expect(citationCandidatesIn(draft)).toEqual(["HR. Bukhari no. 4697"]);
  });
});

describe("normalizeCitationLabel", () => {
  it("collapses whitespace and strips a trailing grade", () => {
    expect(normalizeCitationLabel("  HR.   Bukhari  no.  573 (Sahih) ")).toBe(
      "HR. Bukhari no. 573",
    );
  });

  it("keeps the address's internal colon and drops only a trailing one (#253)", () => {
    // The Quran address IS the colon pair; a naive `replace(/:.*$/, "")` would
    // erase every Quran citation and ground nothing.
    expect(normalizeCitationLabel("QS. 2:255")).toBe("QS. 2:255");
    expect(normalizeCitationLabel("QS. 2:255:")).toBe("QS. 2:255");
    expect(normalizeCitationLabel("QS. Al-Baqarah:255")).toBe("QS. Al-Baqarah:255");
  });

  it("strips the tail punctuation combinations a generator emits (#253)", () => {
    expect(normalizeCitationLabel("HR. Bukhari no. 5010**")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("**HR. Bukhari no. 5010**:")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel('HR. Bukhari no. 5010":')).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("QS. 2:255)")).toBe("QS. 2:255");
  });

  it("strips the grade parenthetical the chunk formatter appends", () => {
    // The grade only ever arrives on the chunk side, as the LAST thing in the
    // label: `formatHadithCitation` writes `HR. X no. N (Grade)`, and the
    // draft grammar's number token stops at whitespace, so no draft span can
    // carry a grade at all (let alone one written after punctuation).
    expect(normalizeCitationLabel("HR. Ibnu Majah no. 224 (Dhaif)")).toBe("HR. Ibnu Majah no. 224");
    expect(normalizeCitationLabel("HR. Ibnu Majah no. 224 (Dhaif) ")).toBe(
      "HR. Ibnu Majah no. 224",
    );
  });

  it("is idempotent", () => {
    for (const label of ["QS. 2:255:", "**HR. Bukhari no. 5010**:", "**HR. Bukhari no. 1**."]) {
      expect(normalizeCitationLabel(normalizeCitationLabel(label))).toBe(
        normalizeCitationLabel(label),
      );
    }
  });
});
