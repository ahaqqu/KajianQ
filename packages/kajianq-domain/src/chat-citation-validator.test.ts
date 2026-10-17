import { describe, expect, it } from "vite-plus/test";
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
import { CITATION_GRAMMARS, declaresAddressList } from "./chat-citation-grammar";
import { reduceCitationLabel } from "./chat-citation-reduce";

/**
 * The deterministic citation validator (the trust invariant). These tests
 * are the adversarial half of the suite: they name the fabrication shapes a
 * model actually produces and prove each one is caught. A weakening of any
 * assertion here is a silent trust regression — the failure mode is a
 * fabricated religious citation delivered as an answer.
 */

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
    // The hadith grammar stops at sentence punctuation but not at `*`, so
    // `**HR. Malik no. 18**` reaches the comparison with its markers attached;
    // markdown emphasis is stripped so a grounded answer is not refused.
    const { grounded, ungrounded } = validateCitations(
      "Menurut **HR. Malik no. 18**, puasa dalam perjalanan …",
      [chunk("HR. Malik no. 18")],
    );
    expect(grounded).toEqual(["HR. Malik no. 18"]);
    expect(ungrounded).toEqual([]);
  });

  it("grounds a hadith citation written with an introducing colon (#253)", () => {
    // The hadith number token stops at `;`, `.`, `)` and `]` but absorbs `:`,
    // so `… no. 5010: <matn>` reaches the comparison colon-suffixed unless the
    // grammar-driven reduction trims that tail — no chunk would ground it.
    const { grounded, ungrounded } = validateCitations(
      "Rasulullah bersabda dalam HR. Bukhari no. 5010: <matn>",
      [chunk("HR. Bukhari no. 5010")],
    );
    expect(grounded).toEqual(["HR. Bukhari no. 5010"]);
    expect(ungrounded).toEqual([]);
  });

  // The class, not the one character: every punctuation a generator plausibly
  // attaches to a citation's tail. Both labels below are retrieved, so any
  // `ungrounded` entry in this table is a grounded citation reported fabricated.
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
    // The rest of the dash family the number token absorbs: these hyphens join
    // prose exactly like the em/en dash above, and none of them is address.
    ["closed-up ASCII hyphen", "Rasulullah bersabda dalam HR. Bukhari no. 5010-ia bersabda"],
    ["figure dash glued prose", "Rasulullah bersabda dalam HR. Bukhari no. 5010‒ia bersabda"],
    ["horizontal bar glued prose", "Rasulullah bersabda dalam HR. Bukhari no. 5010―ia bersabda"],
    // Tails that end in a letter/digit-class character — a footnote
    // digit, a superscript marker (`¹` is `\p{N}`, not an ASCII digit) and the
    // glued grade the draft grammar can really produce. None of them is part
    // of the address, so all three must ground.
    ["footnote digit", "Rasulullah bersabda dalam HR. Bukhari no. 5010:1 tentang hal ini"],
    ["superscript footnote", "Rasulullah bersabda dalam HR. Bukhari no. 5010¹ tentang hal ini"],
    [
      "glued grade parenthetical",
      "Rasulullah bersabda dalam HR. Bukhari no. 5010(Sahih) tentang hal ini",
    ],
    // An omitted space is the same class one spelling further out: the
    // grammars write their separators with `\s*`, so a model that omits the
    // space after `no.` or after the `QS.` marker is citing the retrieved
    // address and must ground.
    ["no space after `no.`", "Rasulullah bersabda dalam HR. Bukhari no.5010: matn"],
    ["no space after the QS. marker", "Ayat Kursi ada di QS.2:255: ayat yang agung"],
    // An invisible format character inside the number is glue, not an address
    // boundary.
    [
      "zero-width non-joiner inside the number",
      "Rasulullah bersabda dalam HR. Bukhari no. 50\u200c10 tentang hal ini",
    ],
    // Fullwidth digits are the same number in another rendering.
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
    // to it is that ADR's recorded revisit trigger).
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
    // A retrieved prefix sibling (`no. 50`) must not ground a citation whose
    // digits one invisible character would split: the digits are one number, so
    // the retrieved `no. 5010` is what it must ground on.
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
    // The scan must read the same characters the comparison side does: a
    // `\p{Cf}` at a grammar-structural position would otherwise make the whole
    // citation invisible and a FABRICATED label pass the gate unseen — the
    // fail-open direction, on the product's top risk.
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
    // them: these two spellings match no grammar, so the scan cannot see them at
    // all and a FABRICATED one passes the gate unseen — the fail-open direction
    // the digit posture on CITATION_GRAMMARS promises not to take. Closing
    // either is a grammar widening (a third hand-synced spelling rule, and for
    // `QS9:99` a reversal of the separator the grammar requires):
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
    // ADR-0049: the label still normalizes to the range as written — the
    // display form, the refusal reason and the pre-gate span — while grounding
    // is decided **per address the grammar declares**.
    expect(normalizeCitationLabel("QS. 2:255—256")).toBe("QS. 2:255—256");
    expect(normalizeCitationLabel("QS. 2:255–256")).toBe("QS. 2:255–256");
    expect(citationSpansIn("Lihat QS. 2:255—256 ya")).toEqual([
      { start: 6, end: 19, label: "QS. 2:255—256" },
    ]);

    const both = [chunk("QS. 2:255"), chunk("QS. 2:256")];
    const headOnly = [chunk("QS. 2:255"), chunk("QS. 2:18")];
    const tailOnly = [chunk("QS. 2:256"), chunk("QS. 2:18")];
    const draft = "Lihat QS. 2:255—256 tentang hal ini";
    // The whole range is present: the answer stands.
    expect(validateCitations(draft, both).ungrounded).toEqual([]);
    // One address missing is still a refusal, whichever one — fail-closed, and
    // strictly tighter than both rejected options (head-first, any-member).
    expect(validateCitations(draft, headOnly).ungrounded).toEqual(["QS. 2:255—256"]);
    expect(validateCitations(draft, tailOnly).ungrounded).toEqual(["QS. 2:255—256"]);
    expect(validateCitations(draft, [chunk("QS. 2:18")]).ungrounded).toEqual(["QS. 2:255—256"]);
  });

  it("keeps the glued Quran compound whole too — the item-4 hole, closed for glue (A1)", () => {
    // The tail tolerates `\p{Cf}` on either side of the dash, so every glued
    // spelling behaves exactly like the plain one — which under ADR-0049 means:
    // refused with the head alone, grounded with every declared address present.
    const onlyFirst = [chunk("QS. 2:255")];
    const both = [chunk("QS. 2:255"), chunk("QS. 2:256")];
    for (const glued of [
      "QS. 2:255\u200c—256", // before the dash
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
    // The plain spelling is the reference every glued one matches.
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
    // The shape the rule exists for: the draft cites `QS. 3:1-2` while the
    // retrieved set holds `QS. 3:2` and not `QS. 3:1`. ADR-0049 puts the head in
    // context at retrieval, and this is the comparison half — the range grounds
    // exactly when the context holds every address it names.
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
    // A single fabricated verse refuses on the same rule.
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
    // so two retrieved endpoints are not the range — its interior addresses were
    // never retrieved and the citation must refuse.
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
    // The chain form names every number it writes: a repeated capture group
    // would hand the declaration only its last iteration, so the earlier numbers
    // would be neither named nor refused.
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
    // `QS. 2:255 - 256` writes the same range with air around the joiner: the
    // chain group tolerates it, because a glued-only dash would stop the scan at
    // the head and leave the second verse the prose names neither enumerated nor
    // refused — grounded on `QS. 2:255` alone.
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
    // For a range the grammar cannot ENUMERATE, `addressesNamedBy` returns
    // `null` (declared, and unenumerable) — never `[label]`, the shape a
    // single-address declaration has — and the comparison site refuses before
    // either rule below can run. Without that distinct state the shortened-label
    // rule would ground the spaced spelling on its head, weaker than its glued
    // twin at exactly the address ADR-0049 names as the refusal case.
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
    // A range whose endpoints are equal (`QS. 1:1–1`) declares exactly ONE
    // address, so the declared-list rule decides it and grounds it when that
    // address is retrieved. ADR-0049's rule is every address the span names, and
    // a range of one names one — a length test cannot see such a list, and the
    // shortened-label rule needs `<label>` + a space and cannot see a range at
    // all.
    const retrieved = [chunk("QS. 1:1"), chunk("QS. 1:5")];
    const rows = [
      // Every glued rendering: a range continues with a dash, while the
      // shortened-label rule needs `<label>` + a space.
      ["QS. 1:1-1", "QS. 1:1"],
      ["QS. 1:1–1", "QS. 1:1"],
      ["QS. 1:1—1", "QS. 1:1"],
      // A no-regression pin for the spaced twin: the head address is followed
      // by a space, so the shortened-label rule accepts this spelling as well —
      // the verdict must not move.
      ["QS. 1:1 - 1", "QS. 1:1"],
      // Spelling coverage, not new shapes: `citationCandidatesIn` folds both
      // marker spellings to the candidate the first row asserts.
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
    // `QS. 1:1-9` is this shape with the tail retrieved by nobody.
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
    // The other fail-closed reason: a surah written by
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

  it("reads the declared-list branch off the grammar's declaration, never off its shape (#449)", () => {
    // The shape test "the declaration names an address other than the span
    // itself" is FALSE for a plain, marker-prefixed span — `addressesNamedBy`
    // names that span itself — so such a span would take the EXTENSION rule and,
    // with a retrieved set holding a bare `QS.` marker, ground on the marker the
    // draft never named. That verdict is silent: a marker is a legal chunk label,
    // the answer cites a real-looking address, no refusal is raised, and no chip
    // is missing. The class is "plain Quran spans" generically, a span written
    // with a surah NAME included (the `QS. Al-Fatihah:1` row below pins it).
    const marker = "QS.";
    for (const written of ["QS. 2:4", "Q.S. 2:4", "QS 2:4"] as const) {
      const candidate = citationCandidatesIn(`Lihat ${written} ya`)[0]!;
      expect(candidate, written).toBe("QS. 2:4");
      // The declaration read is structural — this grammar declares `addressesOf` —
      // so the per-address branch is taken for a span of ANY width, plain included.
      expect(declaresAddressList(candidate), written).toBe(true);
      expect(addressesNamedBy(candidate), written).toEqual(["QS. 2:4"]);
      // The class: the span names `QS. 2:4` and the marker is not that address,
      // so nothing grounds it — grounding on the marker is the fail-open
      // direction.
      expect(groundingLabelsFor(candidate, new Set([marker])), written).toBeNull();
      // The other direction, same span: its own address grounds it, on itself — the
      // branch is not a refusal for a plain citation the corpus does carry.
      expect(groundingLabelsFor(candidate, new Set(["QS. 2:4"])), written).toEqual(["QS. 2:4"]);
      expect(validateCitations(`Lihat ${written} ya`, [chunk("QS. 2:4")]), written).toEqual({
        grounded: ["QS. 2:4"],
        ungrounded: [],
      });
      // Through the gate, on a chunk whose label IS a bare marker: the span stays
      // ungrounded. `grounded` holds `QS` because the marker is literally present in
      // the answer text — the gate's substring pass, never a grounding of this span.
      expect(validateCitations(`Lihat ${written} ya`, [chunk(marker)]), written).toEqual({
        grounded: ["QS"],
        ungrounded: ["QS. 2:4"],
      });
    }
    // The class is "a plain Quran span", not the numeric addresses a sweep can
    // enumerate: the named-surah rendering behaves identically — the named
    // address is unverifiable against the corpus's numeric labels, so the marker
    // was a citation the draft never named. This row pins the wider, unbounded
    // class.
    const namedSurah = citationCandidatesIn("Lihat QS. Al-Fatihah:1 ya")[0]!;
    expect(namedSurah).toBe("QS. Al-Fatihah:1");
    expect(declaresAddressList(namedSurah)).toBe(true);
    expect(addressesNamedBy(namedSurah)).toEqual(["QS. Al-Fatihah:1"]);
    expect(groundingLabelsFor(namedSurah, new Set([marker]))).toBeNull();
    // Its numeric twin — the label a real chunk would carry — does not ground it
    // either: `canonicalizeCitationSpelling` leaves the named spelling alone.
    expect(groundingLabelsFor(namedSurah, new Set(["QS. 1:1"]))).toBeNull();
    expect(validateCitations("Lihat QS. Al-Fatihah:1 ya", [chunk("QS. 1:1")])).toEqual({
      grounded: [],
      ungrounded: ["QS. Al-Fatihah:1"],
    });
    // The gate builds `known` through `normalizeCitationLabel`, which reads a
    // bare marker as `QS`, so no chunk label puts the raw `QS.` in `known` — but
    // the branch must not rest on that, which is the point of reading the
    // grammar's declaration.
    expect(normalizeCitationLabel(marker)).toBe("QS");
    // A grammar that declares NO list keeps the extension rule as its only reading
    // (ADR-0049): the branch must not swallow it. Its behaviour
    // row is the spaced compound pinned below in this suite.
    expect(declaresAddressList("HR. Bukhari no. 5010"), "hadith").toBe(false);
    expect(declaresAddressList(normalizeCitationLabel("Jilid 1, Hal. 102")), "kitab").toBe(false);
    expect(declaresAddressList("bukan kutipan sama sekali"), "no grammar").toBe(false);
    // The refusal set still refuses — with the marker family in `known` too, so the
    // branch cannot ground a shape the fail-closed boundary refuses.
    const refusals: ReadonlyArray<readonly [string, string]> = [
      ["QS. 2:0-0", "QS. 2:255"],
      ["QS. 2:999–999", "QS. 2:255"],
      ["QS. 115:1-1", "QS. 2:255"],
      ["QS. 2:٢٥٥–٢٥٥", "QS. 2:255"],
      ["QS. Al-Fatihah:1–1", "QS. 1:1"],
      ["QS. 1:1-9", "QS. 1:1"],
      ["QS. 1:1–2", "QS. 1:1"],
    ];
    for (const [span, retrieved] of refusals) {
      const candidate = citationCandidatesIn(`Lihat ${span} ya`)[0]!;
      expect(groundingLabelsFor(candidate, new Set([retrieved])), span).toBeNull();
      expect(groundingLabelsFor(candidate, new Set([retrieved, marker])), span).toBeNull();
    }
    // The class this branch exists for, at the width of one, is untouched by
    // it: a degenerate range whose address is retrieved still grounds, marker or no
    // marker in the retrieved set.
    expect(declaresAddressList("QS. 1:1–1")).toBe(true);
    expect(groundingLabelsFor("QS. 1:1–1", new Set(["QS. 1:1"]))).toEqual(["QS. 1:1"]);
    expect(groundingLabelsFor("QS. 1:1–1", new Set(["QS. 1:1", marker]))).toEqual(["QS. 1:1"]);
  });

  it("keeps the accepted set where it was — the fix narrows only the unenumerable spaced form", () => {
    // The property this row guards: the accepted spellings, the enumerable
    // ranges and the grammars that declare no list keep their verdicts — only
    // the unenumerable spaced form is narrowed, and it refuses.
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
    // Still refused: a surah written by name has no enumerable address, a
    // fabricated verse grounds nothing, the hadith compound stays whole even when
    // both addresses were retrieved, and the kitab form's tail is lexical.
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
    // in ADR-0049. Pinned here so a reader of the range rule cannot believe the
    // spaced form is named.
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
    // the hadith grammar declares no address list (`declaresAddressList` is
    // false; `addressesNamedBy` names the label whole), so the extension rule
    // decides it and grounds the compound on its head. No draft path can produce
    // this span — the hadith number token stops at the space before the dash —
    // which is exactly why it needs an assertion here or nowhere: weakening the
    // predicate to a constant `true` or to an unconditional `named.length >= 1`
    // reddens this expectation, so a later simplification cannot retire the
    // exclusion silently.
    expect(
      groundingLabelsFor("HR. Bukhari no. 5010 - 5011", new Set(["HR. Bukhari no. 5010"])),
    ).toEqual(["HR. Bukhari no. 5010"]);
  });

  it("leaves a grammar that declares no address list alone — the hadith compound stays whole", () => {
    // ADR-0049's split is declared per grammar, so a dash-joined hadith number
    // is NOT re-interpreted by a comparison-site pattern: the hadith grammar
    // names one address, `DASH_JOINED_NUMBER_TAIL` keeps the compound whole,
    // and the cost stands — refused even when both addresses were retrieved.
    // Extending `addressesOf` to it is a recorded revisit trigger.
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
    // The scan and the flatten step both read stripped text, so the rows above
    // would pass without the tail's `\p{Cf}` tolerance — this row pins the
    // GRAMMAR's own contract instead: run on RAW text it still takes the whole
    // compound, so the pattern cannot reopen the hole for a caller that forgets
    // to strip. Dropping either `\p{Cf}*` from the tail reddens this row.
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
    // The token stops at whitespace but absorbs `(`, so
    // `HR. Bukhari no. 573(Sahih) …` yields a span carrying grade text; the
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
    // The hadith number token skips the closing bracket, so `[HR. Malik no. 18]`
    // does not produce a phantom `HR. Malik no. 18]` candidate that no chunk
    // grounds — a false refusal of a correctly grounded answer.
    const { grounded, ungrounded } = validateCitations("Hadits [HR. Malik no. 18] berbunyi …", [
      chunk("HR. Malik no. 18"),
    ]);
    expect(grounded).toEqual(["HR. Malik no. 18"]);
    expect(ungrounded).toEqual([]);
  });

  it("grounds a dot-less Quran citation against its dotted label", () => {
    // `QS 2:255` is a common model spelling, so the grammar sees it and
    // normalization matches it to the chunk's dotted label — a grounded answer
    // must not be refused for the spelling of its marker.
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
    // `QS 9:99` (dot-less) is a common spelling, so the grammar must match it
    // or a fabricated citation bypasses the gate.
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
    // Models write the full collection form ("Sunan Abu Dawud"), so the grammar
    // tolerates the collection-type prefix — otherwise a fabricated citation
    // sails through the gate. The comparison form carries the corpus's own
    // collection name, so the refusal reports the address it compared, not the
    // prefix the draft wrapped it in.
    const { ungrounded } = validateCitations("HR. Sunan Abu Dawud no. 99999 menyebutkan …", [
      chunk("HR. Abu Dawud no. 573"),
    ]);
    expect(ungrounded).toEqual(["HR. Abu Dawud no. 99999"]);
  });

  it("catches a fabricated hadith whose collection name is written with spaces", () => {
    // A spaced collection name (`an Nasai`) is tolerated like the hyphenated
    // one, and the comparison form folds it to the corpus's own collection name.
    const { ungrounded } = validateCitations("HR. Sunan an Nasai no. 99999 …", [
      chunk("HR. Bukhari no. 573"),
    ]);
    expect(ungrounded).toEqual(["HR. Nasai no. 99999"]);
  });

  it("catches a fabricated Quran citation written with the dotted Q.S. marker", () => {
    // `Q.S. n:n` is a common spelling in Indonesian religious prose, so the
    // grammar accepts the dotted marker.
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
    // pre-gate key on these labels, and the reduction must leave the address
    // inside them untouched.
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

  it("keeps a label findable inside a longer text whose collection it folds", () => {
    // The grounded-label passes read a whole answer: a comparison form that folded
    // only the text's first hadith address would stop preserving containment, and a
    // label the answer carries later in the prose would read as absent.
    const answer = "Lihat QS. 2:255. Menurut HR. Ibnu Majah no. 224 hal ini sah.";
    expect(citationMatchText(answer)).toContain(citationMatchText("HR. Ibn Majah no. 224"));
  });

  it("does not fold the marker-address spelling the grammar excludes (A2)", () => {
    // The marker fold mirrors the separator the grammar makes mandatory (a dot
    // or a space): folding `QS2:255` to `QS. 2:255` would ground a citation the
    // scan cannot see, asymmetric with the hadith `no 5010` case. Both sides of
    // the comparison agree, and the fold never rewrites a spelling the scan
    // cannot read.
    expect(normalizeCitationLabel("QS2:255")).toBe("QS2:255");
    expect(citationMatchText("di QS2:255 ya")).toBe("di QS2:255 ya");
    expect(citationCandidatesIn("QS2:255")).toEqual([]);
    expect(validateCitations("Ayat Kursi ada di QS2:255", [chunk("QS. 2:255")]).grounded).toEqual(
      [],
    );
    // The spellings the grammar DOES accept keep folding, so a grounded citation
    // is not refused for its spacing.
    expect(normalizeCitationLabel("QS 2:255")).toBe("QS. 2:255");
    expect(normalizeCitationLabel("Q.S. 2:255")).toBe("QS. 2:255");
    expect(normalizeCitationLabel("Q.S.2:255")).toBe("QS. 2:255");
  });

  it("strips the grade parenthetical on both reachable paths, executed (B2)", () => {
    // This anchored pass is reachable on two paths: a label that does NOT begin
    // with a citation grammar (a full Kitab label is the shape it exists for),
    // and a grammar-initial label that is kept WHOLE, where it is the grade
    // remover. The comparison form also carries the corpus's own collection
    // name, which is why the collection below folds while the number does not.
    expect(normalizeCitationLabel("HR. Ibnu Majah no. 224 (Dhaif)")).toBe("HR. Ibn Majah no. 224");
    expect(normalizeCitationLabel("HR. Ibnu Majah no. 224 (Dhaif) ")).toBe("HR. Ibn Majah no. 224");
    // Path 1 — non-grammar-initial: the lexical strip owns the label.
    expect(normalizeCitationLabel("Al-Umm, Imam Syafi'i, Jilid 1, Hal. 102 (Sahih)")).toBe(
      "Al-Umm, Imam Syafi'i, Jilid 1, Hal. 102",
    );
    // Path 2 — grammar-initial but kept whole: the reduction keeps the whole
    // label, so it does NOT remove the grade and this pass does.
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
