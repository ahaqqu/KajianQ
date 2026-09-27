/**
 * The citation grammars the product renders (SPECS §2.1), the **address each
 * grammar identifies inside its own match**, and the spelling an address
 * compares in.
 *
 * A grammar's token class absorbs whatever trails the address until it meets a
 * character it excludes (whitespace, a comma, a closing bracket), and that
 * absorbed tail is not address: the footnote in `HR. Bukhari no. 5010:1`, the
 * superscript in `… no. 5010¹`, the glued grade in `… no. 5010(Sahih` and the
 * prose in `… no. 5010-ia` are one shape — characters the token took along with
 * it, and each one false-refused a grounded citation at the reviewed head
 * (reviews A1/A2). Where an address ends is not decidable from the tail's
 * characters — a trailing-character rule cannot reduce `5010:1` without also
 * eating the verse digits of `QS. 2:255` — but each grammar already knows its
 * own address, and `addressOf` is where it says so.
 * {@link reduceCitationLabel} is the one consumer; `chat-citation-validator`
 * owns the rest of the normalization and the comparison. This module also owns
 * how the address's characters and separators are spelled in the comparison
 * form ({@link stripInvisibleFormatting}, {@link foldAddressDigits},
 * {@link canonicalizeCitationSpelling}) — the same subject, one step later.
 * The split is only for the 300-line agentic limit, not a new seam: this module
 * is internal to the domain pack (not re-exported from `index.ts`) and imports
 * nothing.
 */

/** One citation grammar: a fresh matcher, plus the address inside its match. */
export interface CitationGrammar {
  /** A fresh matcher per call (rationale on {@link CITATION_GRAMMARS}). */
  readonly pattern: () => RegExp;
  /**
   * The address inside this grammar's match, or `null` when the match carries
   * none to reduce to (a hadith number that is not ASCII-digit-led). Such a
   * match is still a citation attempt and is still refused — it simply has no
   * address core, so the lexical tail strip owns it.
   */
  readonly addressOf: (match: RegExpExecArray) => string | null;
}

/**
 * The address at the head of a hadith match's number slot: the ASCII-digit-led
 * number word — `HR. Bukhari no. 5010` out of `… no. 5010:1`, `… no. 5010¹`
 * and `… no. 5010(Sahih`. Letters and further digits continue the number
 * because they make a **different** address: `no. 5010a` and `no. 50102` must
 * never reduce to `no. 5010`, or a wrong or fabricated sub-number would ride in
 * on a retrieved one's grounding (fail-closed).
 */
const HADITH_ADDRESS = /^(.*?no\.\s*\d[\p{L}\p{Nd}]*)/u;

/**
 * The address at the head of a Quran match: the `surah:ayah` pair —
 * `QS. 2:255` out of the compound `QS. 2:255—256`. The grammar's match spans
 * address + absorbed tail (the dash-joined second verse, #264), and this names
 * the address inside it, exactly as {@link HADITH_ADDRESS} does for the number.
 */
const QURAN_ADDRESS = /^\bQ\.?S(?:\.|\s)\s*[^\s:,[\]()]+\s*:\s*\p{Nd}+/iu;

/**
 * The citation grammars the product renders. Literal regexes, not strings
 * compiled on the fly: a constructed regex is the ReDoS shape the security scan
 * blocks, and there is nothing dynamic here to justify it.
 *
 * Each entry is a **factory** returning a fresh regex, because a shared
 * module-level `g` regex carries `lastIndex` state between calls — which would
 * make validation order-dependent, and a non-deterministic safety gate is no
 * gate. Extending the validator for a new source type is one addition here.
 *
 * **Digits (#264).** Every address digit is `\p{Nd}`, so a citation written in
 * another script's decimal digits is still a citation attempt and cannot slip
 * past the gate unseen. The *fold* to the ASCII digits the corpus labels carry
 * belongs to the comparison form, not here (`chat-citation-validator` folds the
 * fullwidth block, the one `\p{Nd}` block that is a rendering variant of
 * ASCII). Every other block therefore stays unfolded and **refuses**: it is
 * recognised, and no retrieved ASCII label grounds it — the fail-closed
 * direction this gate defaults to. The hadith number is stricter still: its
 * address is ASCII-digit-led, and a number in another script has no address
 * core at all, so the lexical tail rule owns it and it likewise refuses.
 */
export const CITATION_GRAMMARS: readonly CitationGrammar[] = [
  // Quran: `QS. 2:255` / `Q.S. 2:255` (both dotted spellings Indonesian prose
  // uses) or `QS. Al-Baqarah:255` (surah numeric or named). The marker closes
  // with a dot OR a space (round-3 A1): the dot-less `QS 2:255` is a common
  // model spelling, and requiring the dot let a fabricated citation bypass the
  // gate entirely. Requiring *some* separator keeps `QS2:255` (no boundary
  // between marker and address) out of the grammar, as before. The match spans
  // address + absorbed tail: it takes a dash-joined second verse with it
  // (`QS. 2:255—256`), so the shared `DASH_JOINED_NUMBER_TAIL` rule keeps the
  // compound whole exactly as it does for the hadith number, instead of
  // dropping the unretrieved second address (#264). `QURAN_ADDRESS` names the
  // `surah:ayah` head inside that match, so the colon and both numbers of
  // `QS. 2:255` stay address, never tail — review A2's counter-case to the
  // hadith footnote.
  {
    pattern: () => /\bQ\.?S(?:\.|\s)\s*[^\s:,[\]()]+\s*:\s*\p{Nd}+(?:[-‐‑‒–—―−]\p{Nd}+)?/giu,
    addressOf: (match) => QURAN_ADDRESS.exec(match[0])?.[0] ?? null,
  },
  // Hadith: `HR. Bukhari no. 573` / `HR. Ibn Majah no. 224 (Dhaif)`, and the
  // dot-less `HR Bukhari no. 573` (round-3 A1, same rationale as the Quran
  // marker). Collection names may be multi-word ("Abu Dawud", "Ibn Majah") and
  // the long forms a model actually writes carry a collection-type prefix
  // ("Sunan Abu Dawud", "Sunan an Nasai"), so up to four tokens are tolerated.
  // Token classes exclude `.` and `,` so the match cannot run across a sentence
  // boundary or swallow a list, and both the token length and the repetition
  // count are bounded — no nested unbounded quantifier, so the pattern stays
  // linear (ReDoS-safe) as required. The trailing number token also skips
  // brackets (#11, found by the citation-payload derivation): `[HR. Malik no.
  // 18]` used to capture a phantom `…no. 18]` span that normalized to nothing a
  // chunk grounds — a false UNGROUNDED, i.e. a refused grounded answer; the
  // Quran address already skipped them. The match therefore spans address +
  // absorbed tail; `HADITH_ADDRESS` names the address inside it (A1/A2).
  {
    pattern: () =>
      /\bHR(?:\.|\s)\s*[^\s,.]{1,24}(?:\s+[^\s,.]{1,24}){0,3}\s+no\.\s*[^\s,;.)[\]]+/gi,
    addressOf: (match) => HADITH_ADDRESS.exec(match[0])?.[1] ?? null,
  },
  // Kitab (SPECS §2.1): `Al-Umm, Imam Syafi'i, Jilid 1, Hal. 102, Bab …`.
  // Kitab ingestion has not landed, so any such citation is ungrounded by
  // definition today — detecting it is the point, not an accident. The match IS
  // the address: the work and author a full Kitab label carries precede it and
  // are not part of it.
  {
    pattern: () => /\bJilid\s+\p{Nd}+\s*,\s*Hal\.\s*\p{Nd}+/giu,
    addressOf: (match) => match[0],
  },
];

/**
 * A dash joined to the address and followed by a DECIMAL DIGIT —
 * `… no. 5010—5011`, `… no. 5010–5011`, `… no. 5010-3`, `… no. 5010—٥٠١١`,
 * and `QS. 2:255—256` on the Quran side — is kept whole instead of being
 * reduced to its first address. This is a deliberate **precision-for-safety
 * trade-off** (review A3), not an oversight:
 *
 * - The dash family is the product's closed-up range joiner, so the compound
 *   may carry a SECOND address. Reducing it to `… no. 5010` would validate only
 *   the first address and silently drop the second from the comparison — an
 *   unretrieved `no. 5011` would ride in on `no. 5010`'s grounding, and
 *   likewise an unretrieved `QS. 2:256` on `QS. 2:255`'s.
 * - One rule covers both grammars because both feed it the same shape: the
 *   grammar's pattern absorbs the dash-joined tail, its `addressOf` names the
 *   head, and the tail is what this constant tests. The Quran pattern grew that
 *   absorption in #264 — the grammar used to end at the first verse's digits,
 *   so the second address never reached the comparison and the compound
 *   grounded on the first verse alone.
 * - The cost is real and accepted: `… 5010—5011` is refused even when BOTH
 *   addresses were retrieved, and digit-glued prose (`… 5010—3 kali sehari`) is
 *   refused with it. Fail-closed is the safe direction for a safety-critical
 *   gate (SPECS §2.2).
 * - The follow-up that closes the cost without reopening the hole belongs at
 *   the comparison site in `chat-citation-validator`: split the compound into
 *   its two addresses and require each grounded — an unretrieved second address
 *   still refuses, a fully grounded range stops being a false refusal. Until
 *   then this constant is the boundary.
 *
 * The class after the dash is `\p{Nd}` — a decimal digit of any script, the
 * class an address number is made of — not `\p{N}`: a superscript or numeric
 * form (`¹`, `½`, both `\p{No}`) is a footnote marker in this prose, not a
 * second address, and `… no. 5010¹` must reduce like any other footnote tail
 * (A2). The dash family covers every character the number token absorbs as a
 * range joiner: `-`, U+2010, U+2011, U+2012, en dash, em dash, horizontal bar
 * and the minus sign.
 */
const DASH_JOINED_NUMBER_TAIL = /^[-‐‑‒–—―−]\p{Nd}/u;

/** The address a citation grammar identifies at the **start** of a label. */
function addressAtStart(label: string): string | null {
  for (const grammar of CITATION_GRAMMARS) {
    const match = grammar.pattern().exec(label);
    if (match?.index !== 0) continue;
    const address = grammar.addressOf(match);
    if (address !== null && address !== "") return address;
  }
  return null;
}

/** How a label that begins with a citation grammar reduces for comparison. */
export interface CitationReduction {
  /** The address the grammar identified — the comparison form. */
  readonly address: string;
  /** The tail is a dash-joined number: keep the whole label whole (A3). */
  readonly keepWhole: boolean;
}

/**
 * Reduce a label that begins with a citation grammar to the address that
 * grammar identified (reviews A1/A2), or `null` when the label does not begin
 * with one. Only a label that starts with the grammar is an address-with-tail;
 * a grammar match later in the label (the work and author of `Al-Umm, Imam
 * Syafi'i, Jilid 1, Hal. 102`) is not, and the lexical tail rule still owns
 * that label.
 */
export function reduceCitationLabel(label: string): CitationReduction | null {
  const address = addressAtStart(label);
  if (address === null) return null;
  return {
    address,
    keepWhole: DASH_JOINED_NUMBER_TAIL.test(label.slice(address.length)),
  };
}

/**
 * Invisible formatting characters (`\p{Cf}`: zero-width space/non-joiner/
 * joiner, the bidi marks, soft hyphen, BOM) carry no address information but
 * split the tokens that read the digits around them: `no. 50\u200c10` used to
 * reduce to `no. 50` — a false refusal against the retrieved `no. 5010`, and,
 * worse, a grounding of a *different* passage whenever a retrieved `no. 50`
 * existed (#264). Dropping them is the same move the markdown-marker strip
 * makes: the characters are invisible, so the comparison form is too.
 *
 * Private, like the fullwidth block below, and reached through a function: a
 * module-level global regex is stateful (`lastIndex`), and a safety gate that
 * depends on call order is no gate (rationale on {@link CITATION_GRAMMARS}).
 */
const INVISIBLE_FORMATTING = /\p{Cf}+/gu;

/** Drop the invisible formatting characters from a label or an answer. */
export function stripInvisibleFormatting(text: string): string {
  return text.replace(INVISIBLE_FORMATTING, "");
}

/**
 * Fullwidth digits (U+FF10–U+FF19) are the one `\p{Nd}` block that is a
 * rendering variant of the ASCII digits the corpus labels carry, so they fold
 * to their ASCII value: `no. ５０１０` is `no. 5010` (#264). Every other
 * `\p{Nd}` block stays unfolded — a general fold needs a per-block zero table
 * (Unicode decimal blocks are not aligned mod 10) and the generator is not
 * observed to emit them — which leaves those scripts recognised and refused,
 * never silently dropped (the posture is stated above on
 * {@link CITATION_GRAMMARS}).
 */
const FULLWIDTH_DIGITS = /[\uFF10-\uFF19]/g;

/** Fold the fullwidth digit block to the ASCII digits the corpus labels use. */
export function foldAddressDigits(text: string): string {
  return text.replace(FULLWIDTH_DIGITS, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
  );
}

/**
 * Canonicalize the **spelling** of a citation's structural separators to the
 * product's forms, so two spellings of one address compare equal. Two families
 * are folded:
 *
 * - **Markers**: the dotted `Q.S.` variant, and — since the grammars accept
 *   the dot-less spellings (round-3 A1) — the bare `QS` / `HR` forms. A model
 *   that writes `Q.S. 2:255` or `QS 2:255` for a chunk labeled `QS. 2:255` is
 *   citing the same address, and treating it as a different one would turn a
 *   *grounded* answer into a refusal. The lookahead on the `HR` rule requires a
 *   following whitespace, so an ordinary word ending in "HR" is never touched.
 * - **Address spacing** (#264): every grammar above writes its separators with
 *   `\s*`, so `no.5010`, `QS.2:255`, `QS. 2: 255` and `Jilid 1,Hal. 102` are
 *   the same addresses as the canonical label a formatter renders. Left
 *   unfolded, a grounded citation was refused for the spelling of its
 *   separator — the same false-refusal class #253 closed for the tail.
 *
 * Fabricated addresses are unaffected by either family: folding separator
 * spacing never changes which digits the address carries, so `no.99999` and
 * `no. 99999` stay distinct from a retrieved `no. 5010`, and `Q.S. 9:99` and
 * `QS 9:99` still normalize to `QS. 9:99`, which no retrieved chunk grounds.
 *
 * The replacements are anchored and idempotent; none of them can re-introduce
 * what another removed.
 */
export function canonicalizeCitationSpelling(text: string): string {
  return text
    .replace(/\bQ\.?S\.?\s*/g, "QS. ")
    .replace(/\bHR\.?(?=\s)/g, "HR.")
    .replace(/\bno\.\s*/g, "no. ")
    .replace(/\bJilid\s+/g, "Jilid ")
    .replace(/\bHal\.\s*/g, "Hal. ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*:\s*/g, ":");
}
