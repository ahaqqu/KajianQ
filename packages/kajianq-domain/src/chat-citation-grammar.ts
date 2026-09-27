/**
 * The citation grammars the product renders (SPECS §2.1), and the **address
 * each grammar identifies inside its own match**.
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
 * owns the rest of the normalization and the comparison. The split is only for
 * the 300-line agentic limit, not a new seam: this module is internal to the
 * domain pack (not re-exported from `index.ts`) and imports nothing.
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
