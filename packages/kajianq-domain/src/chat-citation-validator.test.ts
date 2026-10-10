import { describe, expect, it } from "vitest";
import type { Chunk } from "@app/rag-core";
import {
  addressesNamedBy,
  citationCandidatesIn,
  citationLabelsOf,
  citationMatchText,
  citationSpansIn,
  groundingLabelsFor,
  normalizeCitationLabel,
  validateCitations,
} from "./chat-citation-validator";
import { CITATION_GRAMMARS, reduceCitationLabel } from "./chat-citation-grammar";

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
    // #264 item 3: the same false-refusal class, one spelling further out. The
    // grammars write their separators with `\s*`, so a model that omits the
    // space after `no.` or after the `QS.` marker is citing the retrieved
    // address and must ground.
    ["no space after `no.`", "Rasulullah bersabda dalam HR. Bukhari no.5010: matn"],
    ["no space after the QS. marker", "Ayat Kursi ada di QS.2:255: ayat yang agung"],
    // #264 item 1: an invisible format character inside the number is glue,
    // not an address boundary.
    [
      "zero-width non-joiner inside the number",
      "Rasulullah bersabda dalam HR. Bukhari no. 50\u200c10 tentang hal ini",
    ],
    // #264 item 5: fullwidth digits are the same number in another rendering.
    [
      "fullwidth hadith number",
      "Rasulullah bersabda dalam HR. Bukhari no. ５０１０ tentang hal ini",
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

  it("keeps the hadith dash-joined numeric compound whole — the A3 trade-off that stands", () => {
    // Fail-closed on purpose (`DASH_JOINED_NUMBER_TAIL` in the source): the
    // dash is the closed-up range joiner, so the compound may carry a SECOND
    // address, and reducing it to `no. 5010` would let an unretrieved
    // `no. 5011` ride in on the first address's grounding. The cost is this
    // false refusal — paid even when BOTH addresses were retrieved — and it
    // STANDS for this grammar: the hadith grammar declares no address list, so
    // ADR-0049's per-address check does not touch it (extending `addressesOf`
    // to it is that ADR's recorded revisit trigger, not this change).
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

  it("grounds a citation written without the space after `no.` (#264 item 3)", () => {
    // The address spelling a model plausibly produces for a retrieved label.
    // The grammars write their separators with `\s*`, so the comparison form
    // folds the spacing rather than refusing the answer for it.
    expect(normalizeCitationLabel("HR. Bukhari no.5010")).toBe("HR. Bukhari no. 5010");
    const { grounded, ungrounded } = validateCitations(
      "Rasulullah bersabda dalam HR. Bukhari no.5010: matn",
      [chunk("HR. Bukhari no. 5010")],
    );
    expect(grounded).toEqual(["HR. Bukhari no. 5010"]);
    expect(ungrounded).toEqual([]);
    // The same question for the other two grammars, answered the same way:
    // the marker/separator spacing folds, so the no-space spelling of a
    // retrieved address grounds instead of being refused.
    expect(normalizeCitationLabel("QS.2:255")).toBe("QS. 2:255");
    expect(normalizeCitationLabel("QS. 2: 255")).toBe("QS. 2:255");
    expect(
      validateCitations("Ayat Kursi ada di QS.2:255: ayat yang agung", [chunk("QS. 2:255")])
        .ungrounded,
    ).toEqual([]);
    expect(normalizeCitationLabel("Jilid 1,Hal. 102")).toBe("Jilid 1, Hal. 102");
    expect(
      validateCitations("Al-Umm, Imam Syafi'i, Jilid 1,Hal. 102", [chunk("Jilid 1, Hal. 102")])
        .ungrounded,
    ).toEqual([]);
  });

  it("strips invisible format characters before the number token reads the digits (#264 item 1)", () => {
    // `\p{Cf}` glue carries no address information, so the flatten step drops
    // it and the address token sees the full number.
    expect(normalizeCitationLabel("HR. Bukhari no. 50\u200c10")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("HR. Bukhari no.\u200c5010")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("\u200eHR. Bukhari no. 5010")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("HR. Bukhari no. 5010\u200b")).toBe("HR. Bukhari no. 5010");
  });

  it("grounds on the full number, not the prefix sibling the glue used to truncate to (#264 item 1)", () => {
    // The contrived fail-open the reviewer found: with the invisible character
    // truncating the address to `no. 50`, a retrieved prefix sibling grounded
    // the citation — a DIFFERENT passage than the draft meant. The digits are
    // one number, so the retrieved `no. 5010` is what it must ground on.
    const meant = validateCitations("Rasulullah bersabda dalam HR. Bukhari no. 50\u200c10: matn", [
      chunk("HR. Bukhari no. 5010"),
    ]);
    expect(meant).toEqual({ grounded: ["HR. Bukhari no. 5010"], ungrounded: [] });
    const sibling = validateCitations(
      "Rasulullah bersabda dalam HR. Bukhari no. 50\u200c10: matn",
      [chunk("HR. Bukhari no. 50")],
    );
    // The refusal is what closes the fail-open: the full number the draft
    // cited grounds on no retrieved chunk. (`grounded` stays a substring test
    // of the whole answer, so the sibling's shorter label still appears inside
    // it — an advisory list, never the gate: the answer is refused on
    // `ungrounded`, and a refused answer renders no citations.)
    expect(sibling.ungrounded).toEqual(["HR. Bukhari no. 5010"]);
  });

  it("scans the stripped text, so glue cannot hide a fabricated citation (A3)", () => {
    // The strip used to run only inside normalizeCitationLabel, AFTER the scan
    // had matched the raw draft: a `\p{Cf}` at a grammar-structural position
    // made the whole citation invisible, so a FABRICATED label passed the gate
    // unseen — the fail-open direction, on the product's #1 risk. The scan now
    // reads the same characters the comparison side does.
    expect(
      validateCitations("HR. Bukhari no\u200c. 99999 menjelaskan", [chunk("HR. Bukhari no. 5010")]),
    ).toEqual({ grounded: [], ungrounded: ["HR. Bukhari no. 99999"] });
    expect(citationCandidatesIn("QS\u200c. 2:255 dan QS. 2:\u200c255")).toEqual(["QS. 2:255"]);
    // The grounded direction reads the same characters, so the strip does not
    // refuse the citation it just made visible.
    expect(
      validateCitations("Lihat HR. Bukhari no\u200c. 5010 lanjut", [chunk("HR. Bukhari no. 5010")]),
    ).toEqual({ grounded: ["HR. Bukhari no. 5010"], ungrounded: [] });
    // Spans still point where the draft wrote the citation: the glue sits
    // inside the masked span (its offset is inside [start, end)).
    expect(citationSpansIn("Lihat QS\u200c. 2:255 ya")).toEqual([
      { start: 6, end: 16, label: "QS. 2:255" },
    ]);
    expect(citationSpansIn("Lihat QS. 2:255 ya")).toEqual([
      { start: 6, end: 15, label: "QS. 2:255" },
    ]);
  });

  it("records the grammar-invisible spellings that stay outside every grammar (A3 residual)", () => {
    // Recorded, not closed, and pinned here so the next hunt does not re-find
    // them (the reviewer's "at minimum"). These two spellings match no grammar,
    // so the scan cannot see them at all and a FABRICATED one passes the gate
    // unseen — the fail-open direction the digit posture on CITATION_GRAMMARS
    // promises not to take. Closing either is a grammar widening (a third
    // hand-synced spelling rule, and for `QS9:99` a reversal of the separator
    // round-3 A1 deliberately required), so it is stated in the PR body
    // instead of smuggled in here:
    expect(citationCandidatesIn("QS9:99")).toEqual([]);
    expect(citationCandidatesIn("HR. Bukhari no 99999")).toEqual([]);
    expect(validateCitations("QS9:99 menjelaskan", [chunk("QS. 2:255")])).toEqual({
      grounded: [],
      ungrounded: [],
    });
    expect(
      validateCitations("HR. Bukhari no 99999 menjelaskan", [chunk("HR. Bukhari no. 5010")]),
    ).toEqual({ grounded: [], ungrounded: [] });
  });

  it("folds the fullwidth digit block, the one \\p{Nd} script a label can render (#264 item 5)", () => {
    // Fullwidth digits are the same number, so the fold grounds them instead
    // of leaving the citation invisible (Quran) or refused (hadith).
    expect(normalizeCitationLabel("HR. Bukhari no. ５０１０")).toBe("HR. Bukhari no. 5010");
    expect(normalizeCitationLabel("QS. ２:２５５")).toBe("QS. 2:255");
    expect(citationCandidatesIn("HR. Bukhari no. ５０１０ dan QS. ２:２５５")).toEqual([
      "QS. 2:255",
      "HR. Bukhari no. 5010",
    ]);
    expect(
      validateCitations("Ayat Kursi ada di QS. ２:２５５", [chunk("QS. 2:255")]).ungrounded,
    ).toEqual([]);
    expect(
      validateCitations("Rasulullah bersabda dalam HR. Bukhari no. ５０１０", [
        chunk("HR. Bukhari no. 5010"),
      ]).ungrounded,
    ).toEqual([]);
  });

  it("recognises but never folds the other \\p{Nd} digit scripts (#264 item 5, recorded gap)", () => {
    // Recorded, not half-closed: a general fold needs a per-block zero table
    // (Unicode decimal blocks are not aligned mod 10), the generator is not
    // observed to emit them, and folding only some blocks would refuse the
    // rest anyway. So they are RECOGNISED — never silently invisible — and
    // stay unfolded, which refuses them (fail-closed).
    expect(normalizeCitationLabel("HR. Bukhari no. ٥٠١٠")).toBe("HR. Bukhari no. ٥٠١٠");
    expect(citationCandidatesIn("QS. ٢:٢٥٥")).toEqual(["QS. ٢:٢٥٥"]);
    expect(
      validateCitations("HR. Bukhari no. ٥٠١٠ menjelaskan …", [chunk("HR. Bukhari no. 5010")])
        .ungrounded,
    ).toEqual(["HR. Bukhari no. ٥٠١٠"]);
    expect(validateCitations("QS. ٢:٢٥٥ menjelaskan …", [chunk("QS. 2:255")]).ungrounded).toEqual([
      "QS. ٢:٢٥٥",
    ]);
  });

  it("keeps a dash-joined Quran range whole for DISPLAY, and grounds it per address (#274)", () => {
    // The Quran grammar used to end at the first verse's digits, so the second
    // address never reached the comparison and `QS. 2:255—256` grounded on
    // `QS. 2:255` alone. #264 absorbed the dash-joined tail and the SHARED
    // `DASH_JOINED_NUMBER_TAIL` rule kept the compound whole — which closed
    // that hole but, as #264's own A3 note recorded, refused the range even
    // when BOTH addresses were retrieved. ADR-0049 completes the follow-up that
    // note assigned to this comparison site: the label still normalizes to the
    // range as written (the display form, the refusal reason and the pre-gate
    // span), while grounding is decided **per address the grammar declares**.
    expect(normalizeCitationLabel("QS. 2:255—256")).toBe("QS. 2:255—256");
    expect(normalizeCitationLabel("QS. 2:255–256")).toBe("QS. 2:255–256");
    expect(citationSpansIn("Lihat QS. 2:255—256 ya")).toEqual([
      { start: 6, end: 19, label: "QS. 2:255—256" },
    ]);

    const both = [chunk("QS. 2:255"), chunk("QS. 2:256")];
    const headOnly = [chunk("QS. 2:255"), chunk("QS. 2:18")];
    const tailOnly = [chunk("QS. 2:256"), chunk("QS. 2:18")];
    const draft = "Lihat QS. 2:255—256 tentang hal ini";
    // The whole range is present: the answer stands (the #276 B2 stonewall).
    expect(validateCitations(draft, both).ungrounded).toEqual([]);
    // One address missing is still a refusal, whichever one — fail-closed, and
    // strictly tighter than both rejected options (head-first, any-member).
    expect(validateCitations(draft, headOnly).ungrounded).toEqual(["QS. 2:255—256"]);
    expect(validateCitations(draft, tailOnly).ungrounded).toEqual(["QS. 2:255—256"]);
    expect(validateCitations(draft, [chunk("QS. 2:18")]).ungrounded).toEqual(["QS. 2:255—256"]);
  });

  it("keeps the glued Quran compound whole too — the item-4 hole, closed for glue (A1)", () => {
    // #264 review A1: the plain form refuses, but one invisible format
    // character between the verse and the dash used to stop the pattern's dash
    // tail at the first number — so `QS. 2:255\u200c—256` grounded on the first
    // verse, with only `2:255` retrieved AND with both, while the plain form
    // refuses in both cases. The tail tolerates `\p{Cf}` on either side of the
    // dash, so every glued spelling now behaves exactly like the plain one —
    // which under ADR-0049 means: refused with the head alone, grounded with
    // every declared address present.
    const onlyFirst = [chunk("QS. 2:255")];
    const both = [chunk("QS. 2:255"), chunk("QS. 2:256")];
    for (const glued of [
      "QS. 2:255\u200c—256", // before the dash: the fail-open the review found
      "QS. 2:255—\u200c256", // after the dash
      "QS. 2:255\u200c—\u200c256",
      "QS. 2:255—2\u200c56", // inside the second number
    ]) {
      // The comparison form drops the glue, so every glued spelling names the
      // same two addresses and compares exactly like the plain one.
      expect(normalizeCitationLabel(glued), glued).toBe("QS. 2:255—256");
      expect(validateCitations(`Lihat ${glued} lanjut`, onlyFirst).ungrounded, glued).toEqual([
        "QS. 2:255—256",
      ]);
      expect(validateCitations(`Lihat ${glued} lanjut`, both).ungrounded, glued).toEqual([]);
    }
    // The plain spelling is the reference every glued one now matches.
    expect(validateCitations("Lihat QS. 2:255—256 lanjut", onlyFirst).ungrounded).toEqual([
      "QS. 2:255—256",
    ]);
    expect(validateCitations("Lihat QS. 2:255—256 lanjut", both).ungrounded).toEqual([]);
    // The glued span covers the whole compound too, so the pre-gate mask does
    // not leave the second verse outside it.
    expect(citationSpansIn("Lihat QS. 2:255\u200c—256 ya")).toEqual([
      { start: 6, end: 20, label: "QS. 2:255—256" },
    ]);
  });

  it("grounds a range on every address the grammar declares, and only then (#274)", () => {
    // The real failing label from the incident (eval run 4bfc315f…, trace
    // 3c87fc7a…, question gs-v0-001): the draft cited `QS. 3:1-2` while the
    // retrieved set held `QS. 3:2` and not `QS. 3:1`. The gate correctly
    // withheld it; ADR-0049 puts the head in context at retrieval, and this is
    // the comparison half — the range grounds exactly when the context holds
    // every address it names.
    const real = "Dalilnya QS. 3:1-2 tentang hal ini";
    expect(
      validateCitations(real, [chunk("QS. 3:2"), chunk("QS. 3:18"), chunk("QS. 3:189")]).ungrounded,
    ).toEqual(["QS. 3:1-2"]);
    expect(validateCitations(real, [chunk("QS. 3:1"), chunk("QS. 3:2")]).ungrounded).toEqual([]);
    // A fabricated second address never rides in on the head's grounding.
    expect(
      validateCitations("Dalilnya QS. 3:1-999", [chunk("QS. 3:1"), chunk("QS. 3:2")]).ungrounded,
    ).toEqual(["QS. 3:1-999"]);
    // A range whose tail extends past what was retrieved refuses too.
    expect(
      validateCitations("Dalilnya QS. 3:1-3", [chunk("QS. 3:1"), chunk("QS. 3:2")]).ungrounded,
    ).toEqual(["QS. 3:1-3"]);
    // A single fabricated verse is unchanged (#264's matrix, negative side).
    expect(validateCitations("Dalilnya QS. 9:99", [chunk("QS. 2:255")]).ungrounded).toEqual([
      "QS. 9:99",
    ]);
    // Another script's digits are still recognised and refused (the digit
    // posture on CITATION_GRAMMARS): the list is built from what the grammar
    // names, and Arabic-Indic digits match no ASCII corpus label.
    expect(
      validateCitations("Dalilnya QS. ٣:١-٢", [chunk("QS. 3:1"), chunk("QS. 3:2")]).ungrounded,
    ).toEqual(["QS. ٣:١-٢"]);
    // The dash family is the range joiner in every spelling the token absorbs.
    for (const dash of ["-", "‐", "‑", "‒", "–", "—", "―", "−"]) {
      expect(
        validateCitations(`Dalilnya QS. 3:1${dash}2`, [chunk("QS. 3:1"), chunk("QS. 3:2")])
          .ungrounded,
        dash,
      ).toEqual([]);
    }
  });

  it("names a range's INTERIOR, and every number a multi-dash chain writes (#274 A2 fix)", () => {
    // Strict-whole, owner-decided: `QS. 2:255-260` **names** 255 through 260,
    // so two retrieved endpoints are not the range — four of its addresses were
    // never retrieved and the citation must refuse. The endpoint-pair
    // implementation this replaces grounded it (review A2 of the fix round).
    const interior = "Dalilnya QS. 2:255-260 tentang hal ini";
    expect(
      validateCitations(interior, [chunk("QS. 2:255"), chunk("QS. 2:260")]).ungrounded,
    ).toEqual(["QS. 2:255-260"]);
    const six = [255, 256, 257, 258, 259, 260].map((n) => chunk(`QS. 2:${n}`));
    expect(validateCitations(interior, six).ungrounded).toEqual([]);
    // A hole in the middle refuses exactly like a missing endpoint — that is
    // the whole point of enumerating the interior.
    const holed = six.filter((c) => c.id !== "c-QS. 2:257");
    expect(validateCitations(interior, holed).ungrounded).toEqual(["QS. 2:255-260"]);
    // The chain form names every number it writes. `QS. 3:1-2-3` used to be
    // scanned as `QS. 3:1-2`, so the trailing `-3` was neither named nor
    // refused and 3:1 + 3:2 grounded the citation.
    const chain = "Dalilnya QS. 3:1-2-3 tentang hal ini";
    expect(citationCandidatesIn(chain)).toEqual(["QS. 3:1-2-3"]);
    expect(validateCitations(chain, [chunk("QS. 3:1"), chunk("QS. 3:2")]).ungrounded).toEqual([
      "QS. 3:1-2-3",
    ]);
    expect(
      validateCitations(chain, [chunk("QS. 3:1"), chunk("QS. 3:2"), chunk("QS. 3:3")]).ungrounded,
    ).toEqual([]);
    // An address the surah cannot have makes the span unenumerable, and an
    // unverifiable list REFUSES rather than being shortened to the part it
    // could enumerate — the refusal does not rest on the corpus being pure.
    expect(validateCitations("Dalilnya QS. 2:1-999", [chunk("QS. 2:1")]).ungrounded).toEqual([
      "QS. 2:1-999",
    ]);
    // A surah written by name is bounded by the longest surah and is
    // unverifiable against the corpus's numeric labels, so it still refuses
    // even with the whole span retrieved.
    expect(
      validateCitations("Dalilnya QS. Al-Baqarah:255-256", [chunk("QS. 2:255"), chunk("QS. 2:256")])
        .ungrounded,
    ).toEqual(["QS. Al-Baqarah:255-256"]);
    // The display form is the range as written, interior enumeration or not.
    expect(citationCandidatesIn(interior)).toEqual(["QS. 2:255-260"]);
  });

  it("answers which labels ground a span, so the gate and its consumers share one rule (#274 A1)", () => {
    // The frame derivation and the eval's evidence paths read this instead of
    // re-deciding: the returned labels are what the citation is backed by, and
    // every one of them is in `known` by construction.
    const known = new Set(["QS. 3:1", "QS. 3:2"]);
    expect(groundingLabelsFor("QS. 3:1-2", known)).toEqual(["QS. 3:1", "QS. 3:2"]);
    expect(groundingLabelsFor("QS. 3:1", known)).toEqual(["QS. 3:1"]);
    expect(groundingLabelsFor("QS. 3:3", known)).toBeNull();
    // The same strict-whole rule the validator applies: a range whose interior
    // is not retrieved is not grounded, whoever asks.
    expect(groundingLabelsFor("QS. 3:1-3", known)).toBeNull();
    expect(groundingLabelsFor("QS. 9:99", known)).toBeNull();
    // The naming declaration itself, per grammar: a range names its whole span;
    // a grammar that declares no list names the label whole (so a hadith
    // compound is never reduced to its head).
    expect(addressesNamedBy("QS. 2:255-260")).toEqual([
      "QS. 2:255",
      "QS. 2:256",
      "QS. 2:257",
      "QS. 2:258",
      "QS. 2:259",
      "QS. 2:260",
    ]);
    expect(addressesNamedBy("HR. Bukhari no. 5010-5011")).toEqual(["HR. Bukhari no. 5010-5011"]);
  });

  it("names a spaced range's addresses too — the spaced twin of the A2 hole (review R5)", () => {
    // `QS. 2:255 - 256` writes the same range with air around the joiner.
    // While the chain group required the dash glued, the scan stopped at the
    // head: the second verse the prose named was neither enumerated nor
    // refused, and the gate grounded the citation on `QS. 2:255` alone (A2's
    // class, spaced — pre-existing, and now closed rather than recorded,
    // because the owner's strict-whole decision covers what the prose names).
    const spaced = "Dalilnya QS. 2:255 - 256 tentang hal ini.";
    expect(citationCandidatesIn(spaced)).toEqual(["QS. 2:255 - 256"]);
    expect(addressesNamedBy("QS. 2:255 - 256")).toEqual(["QS. 2:255", "QS. 2:256"]);
    // Both retrieved → grounded, and the provenance names both addresses (the
    // tail is not a literal substring of the span).
    expect(validateCitations(spaced, [chunk("QS. 2:255"), chunk("QS. 2:256")])).toEqual({
      grounded: ["QS. 2:255", "QS. 2:256"],
      ungrounded: [],
    });
    // Head only → REFUSED. This is the row that fails if the declared-list rule
    // ever runs after the shortened-label rule again: the span extends
    // `QS. 2:255` with a space, so that rule would ground it on the head.
    expect(validateCitations(spaced, [chunk("QS. 2:255")]).ungrounded).toEqual(["QS. 2:255 - 256"]);
    // The interior rule reaches the spaced form too.
    expect(
      validateCitations("Dalilnya QS. 2:255 - 260 tentang hal ini.", [
        chunk("QS. 2:255"),
        chunk("QS. 2:260"),
      ]).ungrounded,
    ).toEqual(["QS. 2:255 - 260"]);
    // A newline is not a joiner: the chain never runs across a line boundary.
    expect(citationCandidatesIn("Dalilnya QS. 2:255 -\n256 tentang hal ini.")).toEqual([
      "QS. 2:255",
    ]);
  });

  it("refuses a spaced range it cannot enumerate — the fail-closed state is its own (review T1)", () => {
    // R5 closed the spaced joiner for a range the grammar can ENUMERATE. The
    // unenumerable path came back as `[label]` — the same shape as "this
    // grammar declares a single address" — so `named.length > 1` was false and
    // the shortened-label rule three lines below grounded the span on its head.
    // The spaced spelling was therefore weaker than its glued twin at exactly
    // the address ADR-0049 names as the refusal case. `addressesNamedBy` now
    // returns `null` for it (declared, and unenumerable), and the comparison
    // site refuses before either rule runs.
    const rows = [
      ["Dalilnya QS. 2:1 - 999 tentang hal ini.", "QS. 2:1"],
      ["Dalilnya QS. 2:255 - 0 tentang hal ini.", "QS. 2:255"],
      // Another script's digits name a REAL second verse (2:256) that was not
      // retrieved: the digit posture refuses it, and the refusal must not
      // become a head-only grounding on the way through.
      ["Dalilnya QS. 2:255 - ٢٥٦ tentang hal ini.", "QS. 2:255"],
    ] as const;
    for (const [spaced, retrieved] of rows) {
      const span = citationCandidatesIn(spaced)[0]!;
      // The declaration says "declared, and unenumerable" — NOT a one-element
      // list, which is what a single-address grammar declares.
      expect(addressesNamedBy(span), span).toBeNull();
      expect(groundingLabelsFor(span, new Set([retrieved])), span).toBeNull();
      // Head verse retrieved, tail not: BOTH spellings refuse, and the spaced
      // one reports the whole span it could not verify.
      expect(validateCitations(spaced, [chunk(retrieved)]), spaced).toEqual({
        grounded: [retrieved],
        ungrounded: [span],
      });
      const glued = span.replace(/ - /g, "-");
      expect(validateCitations(glued, [chunk(retrieved)]).ungrounded, glued).toEqual([
        citationCandidatesIn(glued)[0]!,
      ]);
    }
    // The three states really are three, and the ordinary forms keep the other
    // two: no grammar at all names nothing; a single address names itself.
    expect(addressesNamedBy("bukan kutipan sama sekali")).toEqual([]);
    expect(addressesNamedBy("QS. 2:255")).toEqual(["QS. 2:255"]);
    expect(addressesNamedBy("HR. Bukhari no. 5010")).toEqual(["HR. Bukhari no. 5010"]);
  });

  it("grounds a range of ONE address whose address is retrieved — and refuses it when it is not (#444)", () => {
    // The live span (staging, merge `d30c40cf`, trace `b8812e2d-…`): the draft
    // wrote `QS. 1:1–1` — a range whose endpoints are equal, so it declares
    // exactly ONE address — while `QS. 1:1` WAS retrieved. The declared-list
    // rule was gated on `named.length > 1`, so the span skipped it and fell to
    // the shortened-label rule, which needs `<label>` + a space and cannot see a
    // range at all: the gate refused a verifiable citation, and the
    // `ungrounded_citation` trigger replaced a 31-chunk grounded answer with the
    // canonical refusal. ADR-0049's rule is every address the span names, and a
    // range of one names one.
    const retrieved = [chunk("QS. 1:1"), chunk("QS. 1:5")];
    const rows = [
      // The fix's class: every glued rendering was refused at base (`null`),
      // because a range continues with a dash while the shortened-label rule
      // needs `<label>` + a space.
      ["QS. 1:1-1", "QS. 1:1"],
      ["QS. 1:1–1", "QS. 1:1"],
      ["QS. 1:1—1", "QS. 1:1"],
      // NOT the fix's class — a no-regression pin. The head address here is
      // followed by a space, so the extension rule already grounded this
      // spelling at base; what the row proves is that the spaced verdict did
      // not move (the whole spaced family, 8 joiners x 2 addresses, is 0 moved).
      ["QS. 1:1 - 1", "QS. 1:1"],
      // Spelling coverage, not new shapes: `citationCandidatesIn` folds both
      // marker spellings to the candidate the first row already asserts.
      ["Q.S. 1:1-1", "QS. 1:1"],
      ["QS 1:1-1", "QS. 1:1"],
      ["QS. 1:5–5", "QS. 1:5"],
    ] as const;
    for (const [span, address] of rows) {
      const candidate = citationCandidatesIn(`Lihat ${span} ya`)[0]!;
      // The declaration half: a range of one names exactly the address its two
      // endpoints spell — not the head of a written string, and not "nothing".
      expect(addressesNamedBy(candidate), span).toEqual([address]);
      // The comparison half, at the one owner the gate and the frame share.
      expect(groundingLabelsFor(candidate, new Set(["QS. 1:1", "QS. 1:5"])), span).toEqual([
        address,
      ]);
      const { grounded, ungrounded } = validateCitations(`Lihat ${span} ya`, retrieved);
      expect(grounded, span).toEqual([address]);
      expect(ungrounded, span).toEqual([]);
    }
    // The other direction, on the same shape: a retrieved set holding only a
    // SIBLING verse is not the address the span names, and the refusal names the
    // span as the draft wrote it — never the address it names — so the refusal
    // reason, the frame and the reviewer's claim span keep pointing at the text.
    for (const span of ["QS. 1:1–1", "QS. 1:1-1"]) {
      expect(
        validateCitations(`Lihat ${span} ya`, [chunk("QS. 1:2"), chunk("QS. 1:9")]),
        span,
      ).toEqual({ grounded: [], ungrounded: [span] });
    }
    // No weakening: a two-address range with an address missing still refuses —
    // the ticket's own `QS. 1:1-9` row is this shape with the tail retrieved by
    // nobody.
    expect(validateCitations("Lihat QS. 1:1-9 ya", [chunk("QS. 1:1")]).ungrounded).toEqual([
      "QS. 1:1-9",
    ]);
    expect(validateCitations("Lihat QS. 1:1–2 ya", [chunk("QS. 1:1")]).ungrounded).toEqual([
      "QS. 1:1–2",
    ]);
    // Fail-closed where the grammar cannot ENUMERATE, degenerate or not: an
    // address the surah cannot have, a surah outside the table, and another
    // script's digits all declare an unverifiable list — they refuse rather than
    // collapsing to the one address they spell (ADR-0049's third state, the range
    // module's `null`, which is not a one-element list).
    for (const span of ["QS. 2:0-0", "QS. 2:999–999", "QS. 115:1-1", "QS. 2:٢٥٥–٢٥٥"]) {
      const candidate = citationCandidatesIn(`Lihat ${span} ya`)[0]!;
      expect(addressesNamedBy(candidate), span).toBeNull();
      expect(groundingLabelsFor(candidate, new Set(["QS. 1:1", "QS. 2:255"])), span).toBeNull();
      expect(validateCitations(`Lihat ${span} ya`, [chunk("QS. 2:255")]), span).toEqual({
        grounded: [],
        ungrounded: [candidate],
      });
    }
    // The other fail-closed reason, untouched by this fix: a surah written by
    // NAME is enumerable — bounded by the longest surah — but unverifiable
    // against the corpus's numeric labels, so a range of one in that spelling
    // refuses in the comparison instead. It grounds no address by collapsing to
    // the one it names, and it never reaches the unenumerable state either.
    const named = citationCandidatesIn("Lihat QS. Al-Fatihah:1–1 ya")[0]!;
    expect(addressesNamedBy(named)).toEqual(["QS. Al-Fatihah:1"]);
    expect(groundingLabelsFor(named, new Set(["QS. 1:1"])), named).toBeNull();
    expect(validateCitations("Lihat QS. Al-Fatihah:1–1 ya", [chunk("QS. 1:1")])).toEqual({
      grounded: [],
      ungrounded: ["QS. Al-Fatihah:1–1"],
    });
  });

  it("keeps the accepted set where it was — the fix narrows only the unenumerable spaced form", () => {
    // The differential this fix round re-ran, base `c64696f` vs this head, over
    // 21,438 answer × retrieved-set combinations: **widened 0, narrowed 696**,
    // and every narrowed combination is one of the three unenumerable spaced
    // spans above (232 retrieved-sets each). Nothing else moved — which is the
    // property this row guards: the accepted spellings, the enumerable ranges
    // and the grammars that declare no list must behave exactly as before.
    const accepted: Array<[string, string[], string[]]> = [
      // [answer, retrieved, grounded]
      [
        "Dalilnya QS. 2:255-256 tentang hal ini.",
        ["QS. 2:255", "QS. 2:256"],
        ["QS. 2:255", "QS. 2:256"],
      ],
      [
        "Dalilnya QS. 2:255—256 tentang hal ini.",
        ["QS. 2:255", "QS. 2:256"],
        ["QS. 2:255", "QS. 2:256"],
      ],
      [
        "Dalilnya QS. 2:255‑256 tentang hal ini.",
        ["QS. 2:255", "QS. 2:256"],
        ["QS. 2:255", "QS. 2:256"],
      ],
      [
        "Dalilnya QS. 2:255- 256 tentang hal ini.",
        ["QS. 2:255", "QS. 2:256"],
        ["QS. 2:255", "QS. 2:256"],
      ],
      [
        "Dalilnya QS. 2:255 -256 tentang hal ini.",
        ["QS. 2:255", "QS. 2:256"],
        ["QS. 2:255", "QS. 2:256"],
      ],
      [
        "Dalilnya QS. 2:255 - 256 tentang hal ini.",
        ["QS. 2:255", "QS. 2:256"],
        ["QS. 2:255", "QS. 2:256"],
      ],
      [
        "Dalilnya Q.S. 2:255-256 tentang hal ini.",
        ["QS. 2:255", "QS. 2:256"],
        ["QS. 2:255", "QS. 2:256"],
      ],
      [
        "Dalilnya QS 2:255-256 tentang hal ini.",
        ["QS. 2:255", "QS. 2:256"],
        ["QS. 2:255", "QS. 2:256"],
      ],
      [
        "Dalilnya QS. 3:1-2-3 tentang hal ini.",
        ["QS. 3:1", "QS. 3:2", "QS. 3:3"],
        ["QS. 3:1", "QS. 3:2", "QS. 3:3"],
      ],
      [
        "Dalilnya QS. 3:1 - 2 - 3 tentang hal ini.",
        ["QS. 3:1", "QS. 3:2", "QS. 3:3"],
        ["QS. 3:1", "QS. 3:2", "QS. 3:3"],
      ],
      [
        "Dalilnya QS. 2:255-260 tentang hal ini.",
        ["QS. 2:255", "QS. 2:256", "QS. 2:257", "QS. 2:258", "QS. 2:259", "QS. 2:260"],
        ["QS. 2:255", "QS. 2:256", "QS. 2:257", "QS. 2:258", "QS. 2:259", "QS. 2:260"],
      ],
      [
        "HR. Bukhari no. 573 (Sahih) menjelaskan …",
        ["HR. Bukhari no. 573"],
        ["HR. Bukhari no. 573"],
      ],
      ["QS. 2:255 disebut.", ["QS. 2:255"], ["QS. 2:255"]],
    ];
    for (const [answer, retrieved, grounded] of accepted) {
      const result = validateCitations(
        answer,
        retrieved.map((label) => chunk(label)),
      );
      // Sets, not orders: a range's provenance is assembled from the substring
      // pass and the declared list, and which one reaches each address first is
      // not part of the claim.
      expect([...result.grounded].sort(), answer).toEqual([...grounded].sort());
      expect(result.ungrounded, answer).toEqual([]);
    }
    // Still refused, exactly as before (all four are in the differential's
    // unchanged bucket): a surah written by name has no enumerable address, a
    // fabricated verse grounds nothing, the #264 A3 hadith compound stays whole
    // even when both addresses were retrieved, and the kitab form's tail is
    // lexical.
    expect(
      validateCitations("Dalilnya QS. Al-Baqarah:255-256 tentang hal ini.", [
        chunk("QS. 2:255"),
        chunk("QS. 2:256"),
      ]).ungrounded,
    ).toEqual(["QS. Al-Baqarah:255-256"]);
    expect(
      validateCitations("Dalilnya QS. 9:99 tentang hal ini.", [chunk("QS. 2:255")]).ungrounded,
    ).toEqual(["QS. 9:99"]);
    expect(
      validateCitations("HR. Bukhari no. 5010—5011 menjelaskan …", [
        chunk("HR. Bukhari no. 5010"),
        chunk("HR. Bukhari no. 5011"),
      ]).ungrounded,
    ).toEqual(["HR. Bukhari no. 5010—5011"]);
  });

  it("keeps the DRAFT-side spaced hadith form out of the grammar — recorded, not silent", () => {
    // The hadith number token stops at whitespace, so the spaced hadith range
    // is scanned as its head and grounds on it. That is a deliberate exclusion
    // (the token rule), not a second reading of the chain rule: extending the
    // hadith grammar to a spaced joiner is the "Hadith ranges" revisit trigger
    // in ADR-0049, kept out of #274. Pinned here so a reader of the range rule
    // cannot believe the spaced form is named (review R5's "silence is the one
    // option that leaves a reader believing the range is named").
    const draft = "HR. Bukhari no. 5010 - 5011 menjelaskan …";
    expect(citationCandidatesIn(draft)).toEqual(["HR. Bukhari no. 5010"]);
    expect(validateCitations(draft, [chunk("HR. Bukhari no. 5010")]).ungrounded).toEqual([]);
    // The label side of the same spelling IS kept whole (the shared tail rule
    // tolerates the air around the joiner), so a chunk label written that way
    // never reduces to its head either.
    expect(addressesNamedBy("HR. Bukhari no. 5010 - 5011")).toEqual([
      "HR. Bukhari no. 5010 - 5011",
    ]);
    // The comparison half, and the reason it is pinned rather than inferred:
    // this label is the one input the #444 branch deliberately routes AROUND
    // the declared-list rule. The declaration is the whole label
    // (`named[0] === candidate`), so the extension rule decides it and grounds
    // the compound on its head. No draft path can produce this span — the
    // hadith number token stops at the space before the dash — which is exactly
    // why it needs an assertion here or nowhere: weaken the branch to an
    // unconditional `named.length >= 1` (review A1's mutation 2, which left the
    // whole suite green before this row existed) and this expectation reddens,
    // so the next simplification of the predicate cannot retire the exclusion
    // silently.
    expect(
      groundingLabelsFor("HR. Bukhari no. 5010 - 5011", new Set(["HR. Bukhari no. 5010"])),
    ).toEqual(["HR. Bukhari no. 5010"]);
  });

  it("leaves a grammar that declares no address list alone — the hadith compound stays whole", () => {
    // ADR-0049's split is declared per grammar, so a dash-joined hadith number
    // is NOT re-interpreted by a comparison-site pattern: the hadith grammar
    // names one address, `DASH_JOINED_NUMBER_TAIL` keeps the compound whole,
    // and the #264 A3 cost stands there unchanged (both retrieved, still
    // refused). Extending `addressesOf` to it is a recorded revisit trigger.
    const both = [chunk("HR. Bukhari no. 5010"), chunk("HR. Bukhari no. 5011")];
    expect(validateCitations("HR. Bukhari no. 5010—5011 menjelaskan …", both).ungrounded).toEqual([
      "HR. Bukhari no. 5010—5011",
    ]);
    // Digit-glued prose is refused with it: the accepted cost, not a bug.
    expect(
      validateCitations("HR. Bukhari no. 5010—3 kali sehari", [chunk("HR. Bukhari no. 5010")])
        .ungrounded,
    ).toEqual(["HR. Bukhari no. 5010—3"]);
  });

  it("keeps the glued compound whole in the grammar itself, not only via the strip (A1)", () => {
    // The scan and the flatten step both read stripped text today, so the rows
    // above would pass even without the tail's `\p{Cf}` tolerance — which is
    // exactly why this row pins the GRAMMAR's own contract instead: run on RAW
    // text it still takes the whole compound. That is the difference between
    // "A1 is closed because two callers happen to strip first" and "the pattern
    // cannot reopen the hole for a caller that forgets to". Dropping either
    // `\p{Cf}*` from the tail reddens this row (executed by mutation).
    const quranMatch = (text: string) => CITATION_GRAMMARS[0]!.pattern().exec(text);
    for (const glued of [
      "QS. 2:255\u200c—256",
      "QS. 2:255—\u200c256",
      "QS. 2:255\u200c—\u200c256",
    ]) {
      // A fresh regex per call, deliberately: a shared `/g` matcher would carry
      // `lastIndex` and the second call would miss.
      const match = quranMatch(glued);
      expect(match?.[0], glued).toBe(glued);
      expect(CITATION_GRAMMARS[0]!.addressOf(match!), glued).toBe("QS. 2:255");
    }
  });

  it("records why a comma- or space-separated second verse is NOT a compound (#264 item 4)", () => {
    // Deliberate boundary, stated rather than left implicit: the closed-up
    // dash is the product's range joiner, and both grammars read it that way.
    // A second verse written after a comma or a space carries no marker of its
    // own, so it is a bare number — and bare numbers are not citation attempts
    // (`ignores bare numbers and ordinary prose` above). The hadith grammar
    // behaves identically (its token stops at the comma), so the two grammars
    // agree here too.
    expect(normalizeCitationLabel("QS. 2:255, 256")).toBe("QS. 2:255");
    expect(
      validateCitations("Lihat QS. 2:255, 256 tentang hal ini", [chunk("QS. 2:255")]).ungrounded,
    ).toEqual([]);
    expect(
      validateCitations("HR. Bukhari no. 5010, 5011 menjelaskan …", [chunk("HR. Bukhari no. 5010")])
        .ungrounded,
    ).toEqual([]);
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

  it("still rejects a fabricated or near-miss no-space address (#264 item 3, reverse direction)", () => {
    // Folding the separator spacing must never fold the number with it.
    expect(
      validateCitations("HR. Bukhari no.99999 menyebutkan …", [chunk("HR. Bukhari no. 5010")])
        .ungrounded,
    ).toEqual(["HR. Bukhari no. 99999"]);
    expect(
      validateCitations("HR. Bukhari no.5011 menyebutkan …", [chunk("HR. Bukhari no. 5010")])
        .ungrounded,
    ).toEqual(["HR. Bukhari no. 5011"]);
    expect(validateCitations("QS.9:99 tentang hal ini", [chunk("QS. 2:255")]).ungrounded).toEqual([
      "QS. 9:99",
    ]);
    // A longer number written without the space is still a different address:
    // the fold moves separators, never digits.
    expect(
      validateCitations("HR. Bukhari no.50102 menjelaskan …", [chunk("HR. Bukhari no. 5010")])
        .ungrounded,
    ).toEqual(["HR. Bukhari no. 50102"]);
  });

  it("still rejects a fabricated number however it is glued or rendered (#264 items 1 and 5)", () => {
    // Joining invisible characters, or folding a digit script, must never
    // ground an invented number on a retrieved one.
    expect(
      validateCitations("HR. Bukhari no. 9999\u200c9 menjelaskan …", [
        chunk("HR. Bukhari no. 5010"),
      ]).ungrounded,
    ).toEqual(["HR. Bukhari no. 99999"]);
    expect(
      validateCitations("HR. Bukhari no. ５０１１ menjelaskan …", [chunk("HR. Bukhari no. 5010")])
        .ungrounded,
    ).toEqual(["HR. Bukhari no. 5011"]);
    expect(
      validateCitations("QS. ９:９９ tentang hal ini", [chunk("QS. 2:255")]).ungrounded,
    ).toEqual(["QS. 9:99"]);
  });

  it("still rejects a closed-up Quran range whose second address was not retrieved (#264 item 4)", () => {
    // The other grammar of the same rule: the compound is kept whole, so the
    // verse the draft cites and retrieval did not return refuses the answer.
    expect(
      validateCitations("Lihat QS. 2:255—256 tentang hal ini", [chunk("QS. 2:255")]).ungrounded,
    ).toEqual(["QS. 2:255—256"]);
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

  it("does not fold the marker-address spelling the grammar excludes (A2)", () => {
    // #264 review A2: the QS marker rule used to fold `QS2:255` to `QS. 2:255`
    // even though no grammar matches that spelling — so the comparison form
    // grounded a citation the scan could not see, asymmetric with the hadith
    // `no 5010` case. The rule now mirrors the separator the grammar makes
    // mandatory (a dot or a space), so both sides of the comparison agree and
    // the fold never rewrites a spelling the scan cannot read.
    expect(normalizeCitationLabel("QS2:255")).toBe("QS2:255");
    expect(citationMatchText("di QS2:255 ya")).toBe("di QS2:255 ya");
    expect(citationCandidatesIn("QS2:255")).toEqual([]);
    expect(validateCitations("Ayat Kursi ada di QS2:255", [chunk("QS. 2:255")]).grounded).toEqual(
      [],
    );
    // The spellings the grammar DOES accept keep folding, so the false refusal
    // #264 item 3 closed stays closed.
    expect(normalizeCitationLabel("QS 2:255")).toBe("QS. 2:255");
    expect(normalizeCitationLabel("Q.S. 2:255")).toBe("QS. 2:255");
    expect(normalizeCitationLabel("Q.S.2:255")).toBe("QS. 2:255");
  });

  it("strips the grade parenthetical on both reachable paths, executed (B2)", () => {
    // This anchored pass is reachable for a label that does NOT begin with a
    // citation grammar — a full Kitab label is the shape it exists for — OR for
    // a grammar-initial label that is kept WHOLE, where it is the grade remover.
    // The earlier wording stopped at the first half and the kept-whole compound
    // falsified it (review B2); the source docstring now names both paths, and
    // both are executed here.
    expect(normalizeCitationLabel("HR. Ibnu Majah no. 224 (Dhaif)")).toBe("HR. Ibnu Majah no. 224");
    expect(normalizeCitationLabel("HR. Ibnu Majah no. 224 (Dhaif) ")).toBe(
      "HR. Ibnu Majah no. 224",
    );
    // Path 1 — non-grammar-initial: the lexical strip owns the label.
    expect(normalizeCitationLabel("Al-Umm, Imam Syafi'i, Jilid 1, Hal. 102 (Sahih)")).toBe(
      "Al-Umm, Imam Syafi'i, Jilid 1, Hal. 102",
    );
    // Path 2 — grammar-initial but kept whole: the reduction keeps the whole
    // label, so it does NOT remove the grade and this pass does (B2).
    expect(reduceCitationLabel("HR. Bukhari no. 5010—5011 (Dhaif)")).toEqual({
      address: "HR. Bukhari no. 5010",
      keepWhole: true,
    });
    expect(normalizeCitationLabel("HR. Bukhari no. 5010—5011 (Dhaif)")).toBe(
      "HR. Bukhari no. 5010—5011",
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
