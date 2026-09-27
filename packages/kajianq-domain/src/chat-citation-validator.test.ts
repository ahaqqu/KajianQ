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
    // Review A1: the rest of the dash family the number token absorbs. These
    // hyphens join prose exactly like the em/en dash above, and all three were
    // still false-refusing a grounded citation at the reviewed head.
    ["closed-up ASCII hyphen", "Rasulullah bersabda dalam HR. Bukhari no. 5010-ia bersabda"],
    ["figure dash glued prose", "Rasulullah bersabda dalam HR. Bukhari no. 5010‒ia bersabda"],
    ["horizontal bar glued prose", "Rasulullah bersabda dalam HR. Bukhari no. 5010―ia bersabda"],
    // Review A2: tails that end in a letter/digit-class character — a footnote
    // digit, a superscript marker (`¹` is `\p{N}`, not an ASCII digit) and the
    // glued grade the draft grammar can really produce. None of them is part
    // of the address, so all three must ground.
    ["footnote digit", "Rasulullah bersabda dalam HR. Bukhari no. 5010:1 tentang hal ini"],
    ["superscript footnote", "Rasulullah bersabda dalam HR. Bukhari no. 5010¹ tentang hal ini"],
    [
      "glued grade parenthetical",
      "Rasulullah bersabda dalam HR. Bukhari no. 5010(Sahih) tentang hal ini",
    ],
  ])("grounds a citation whose tail is a %s", (_variant, draft) => {
    const { ungrounded } = validateCitations(draft, [
      chunk("HR. Bukhari no. 5010"),
      chunk("QS. 2:255"),
    ]);
    expect(ungrounded).toEqual([]);
  });

  it("reduces a tail to the address its grammar identified, not by punctuation (A2)", () => {
    // The pair no trailing-character rule can separate: the footnote must
    // reduce to the hadith address, while the Quran address must keep its
    // colon and BOTH of its numbers. The grammars already know which is which
    // — the hadith address ends at the number word after `no.`, the Quran
    // address IS the `surah:ayah` pair — so `normalizeCitationLabel` trims the
    // match to the grammar's own address instead of guessing from the tail.
    expect(normalizeCitationLabel("HR. Bukhari no. 5010:1")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("HR. Bukhari no. 5010¹")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("HR. Bukhari no. 5010(Sahih")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("HR. Bukhari no. 5010-ia")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("QS. 2:255")).toBe("QS. 2:255");
    expect(normalizeCitationLabel("QS. 2:255:")).toBe("QS. 2:255");
    expect(normalizeCitationLabel("QS. Al-Baqarah:255")).toBe("QS. Al-Baqarah:255");
  });

  it("keeps the dash-joined numeric compound whole — the stated A3 trade-off", () => {
    // Fail-closed on purpose (`DASH_JOINED_NUMBER_TAIL` in the source): the
    // dash is the closed-up range joiner, so the compound may carry a SECOND
    // address, and reducing it to `no. 5010` would let an unretrieved
    // `no. 5011` ride in on the first address's grounding. The cost is this
    // false refusal — paid even when BOTH addresses were retrieved — and the
    // follow-up (split the compound at the comparison site, require each
    // grounded) is recorded in the source comment, not left to be rediscovered.
    const bothRetrieved = [chunk("HR. Bukhari no. 5010"), chunk("HR. Bukhari no. 5011")];
    expect(
      validateCitations("HR. Bukhari no. 5010—5011 menjelaskan …", bothRetrieved).ungrounded,
    ).toEqual(["HR. Bukhari no. 5010—5011"]);
    // Digit-glued prose is refused with it: the accepted cost, not a bug.
    expect(
      validateCitations("HR. Bukhari no. 5010—3 kali sehari", [chunk("HR. Bukhari no. 5010")])
        .ungrounded,
    ).toEqual(["HR. Bukhari no. 5010—3"]);
  });

  it("keeps an address-bearing glue distinct from the bare number (fail-closed)", () => {
    // Letters and digits glued straight onto the number continue the address
    // token: `no. 50102` and `no. 5010a` are different addresses than
    // `no. 5010`. Dropping the glue would ground a wrong or fabricated
    // sub-number on a retrieved one, so these stay distinct and refused.
    for (const glued of [
      "HR. Bukhari no. 50101",
      "HR. Bukhari no. 5010a",
      "HR. Bukhari no. 5010ia",
    ]) {
      expect(normalizeCitationLabel(glued)).toBe(glued);
      expect(
        validateCitations(`${glued} menjelaskan …`, [chunk("HR. Bukhari no. 5010")]).ungrounded,
      ).toEqual([glued]);
    }
  });

  it("reduces the glued grade span the draft grammar really produces (B2)", () => {
    // The `stripGradeSuffix` docstring used to claim no draft span can carry a
    // grade at all, because "the number token stops at whitespace". Execution
    // falsified it: the token stops at whitespace but absorbs `(`, so
    // `HR. Bukhari no. 573(Sahih) …` yields a span carrying grade text. The
    // spaced forms are the ones that cannot occur.
    expect(citationSpansIn("HR. Bukhari no. 573(Sahih) menjelaskan")).toEqual([
      { start: 0, end: 25, label: "HR. Bukhari no. 573" },
    ]);
    expect(citationSpansIn("HR. Bukhari no. 573 (Sahih) menjelaskan")[0]?.label).toBe(
      "HR. Bukhari no. 573",
    );
    expect(citationSpansIn("HR. Bukhari no. 573: (Sahih) menjelaskan")[0]?.label).toBe(
      "HR. Bukhari no. 573",
    );
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

  it("still rejects a fabricated hadith number written with a footnote digit (A2)", () => {
    // Reducing `5010:1` to `5010` must not reduce `99999:1` to anything a
    // retrieved chunk grounds: the footnote number is not address, and the
    // fabricated number still is.
    const { grounded, ungrounded } = validateCitations("HR. Bukhari no. 99999:1 menjelaskan …", [
      chunk("HR. Bukhari no. 5010"),
    ]);
    expect(grounded).toEqual([]);
    expect(ungrounded).toEqual(["HR. Bukhari no. 99999"]);
  });

  it("still rejects a closed-up hadith range whose second address was not retrieved", () => {
    // A dash joined to more address digits is kept whole — the deliberate
    // precision-for-safety trade-off on `DASH_JOINED_NUMBER_TAIL` — so a
    // range keeps both addresses and the unretrieved one is caught. The cost
    // of that decision is pinned in the grounded-direction suite.
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
    // erase every Quran citation and ground nothing. The reduction is to the
    // grammar's address, which is why the footnote below loses its colon tail
    // while this address keeps its colon.
    expect(normalizeCitationLabel("QS. 2:255")).toBe("QS. 2:255");
    expect(normalizeCitationLabel("QS. 2:255:")).toBe("QS. 2:255");
    expect(normalizeCitationLabel("QS. Al-Baqarah:255")).toBe("QS. Al-Baqarah:255");
    expect(normalizeCitationLabel("HR. Bukhari no. 5010:1")).toBe("HR. Bukhari no. 5010");
  });

  it("strips the tail punctuation combinations a generator emits (#253, A1, A2)", () => {
    expect(normalizeCitationLabel("HR. Bukhari no. 5010**")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("**HR. Bukhari no. 5010**:")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel('HR. Bukhari no. 5010":')).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("QS. 2:255)")).toBe("QS. 2:255");
    expect(normalizeCitationLabel("HR. Bukhari no. 5010-ia")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("HR. Bukhari no. 5010‒ia")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("HR. Bukhari no. 5010―ia")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("HR. Bukhari no. 5010¹")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("HR. Bukhari no. 5010(Sahih")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("HR. Bukhari no. 5010：")).toBe("HR. Bukhari no. 5010");
  });

  it("strips the grade parenthetical the chunk formatter appends", () => {
    // The grade arrives on the chunk side as the LAST thing in the label:
    // `formatHadithCitation` writes `HR. X no. N (Grade)`, and this anchored
    // pass removes it there. On the draft side only the SPACED form is
    // unreachable (the number token stops at whitespace); the glued
    // `HR. X no. N(Grade)` span does occur and is reduced by the
    // grammar-address rule — see the glued-grade span test above (B2).
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
