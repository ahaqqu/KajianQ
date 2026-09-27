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
 * own address, and `addressOf` is where it says so. {@link reduceCitationLabel}
 * is the one consumer; `chat-citation-validator` owns the rest of the
 * normalization and the comparison. This module also owns how the address's
 * characters and separators are spelled in the comparison form
 * ({@link stripInvisibleFormatting}, {@link foldAddressDigits},
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
   * none to reduce to (a hadith number that is not ASCII-digit-led) — still a
   * citation attempt, still refused, with the lexical tail strip owning it.
   */
  readonly addressOf: (match: RegExpExecArray) => string | null;
}

/**
 * The address at the head of a hadith match's number slot: the ASCII-digit-led
 * number word — `HR. Bukhari no. 5010` out of `… no. 5010:1`, `… no. 5010¹`
 * and `… no. 5010(Sahih`. Letters and further digits continue the number
 * because they make a **different** address: `no. 5010a` and `no. 50102` must
 * never reduce to `no. 5010`, or a fabricated sub-number would ride in on a
 * retrieved one's grounding (fail-closed).
 */
const HADITH_ADDRESS = /^(.*?no\.\s*\d[\p{L}\p{Nd}]*)/u;

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
  // between marker and address) out of the grammar — a recorded exclusion that
  // `canonicalizeCitationSpelling` now mirrors, so the fold never rewrites a
  // spelling this scan cannot see (review A2). The match spans address +
  // absorbed tail: it takes a dash-joined second verse with it
  // (`QS. 2:255—256`), so the shared `DASH_JOINED_NUMBER_TAIL` rule keeps the
  // compound whole exactly as it does for the hadith number (#264). The
  // **capture group** is the `surah:ayah` head inside that match — the colon
  // and both numbers of `QS. 2:255` stay address, never tail (review A2's
  // counter-case to the hadith footnote) — so the hand-synced second address
  // regex this grammar used to carry is gone (review B3). The dash tail
  // tolerates `\p{Cf}` on either side of the dash (review A1): the hadith token
  // absorbs that glue and keeps its compound, but this pattern is structured
  // and used to stop at it, grounding `QS. 2:255\u200c—256` on the first verse
  // alone. Only those two positions need it — glue inside either number
  // truncates the match and the compound is kept whole and refused.
  {
    pattern: () =>
      /(\bQ\.?S(?:\.|\s)\s*[^\s:,[\]()]+\s*:\s*\p{Nd}+)(?:\p{Cf}*[-‐‑‒–—―−]\p{Cf}*\p{Nd}+)?/giu,
    addressOf: (match) => match[1] ?? null,
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
  // the address; the work and author the label carries precede it.
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
 *   may carry a SECOND address. Reducing it to `… no. 5010` would validate the
 *   first and silently drop the second — an unretrieved `no. 5011` would ride
 *   in on `no. 5010`'s grounding, and `QS. 2:256` on `QS. 2:255`'s.
 * - One rule covers both grammars because both feed it the same shape: the
 *   pattern absorbs the dash-joined tail, `addressOf` names the head, and the
 *   tail is what this constant tests. The Quran pattern grew that absorption in
 *   #264, where it used to stop at the first verse and ground on it alone.
 * - The cost is real and accepted: `… 5010—5011` is refused even when BOTH
 *   addresses were retrieved, and digit-glued prose (`… 5010—3 kali sehari`) is
 *   refused with it. Fail-closed is the safe direction for a safety-critical
 *   gate (SPECS §2.2).
 * - The follow-up that closes the cost without reopening the hole belongs at
 *   the comparison site in `chat-citation-validator`: split the compound and
 *   require each address grounded. Until then this constant is the boundary.
 *
 * The class after the dash is `\p{Nd}` — a decimal digit of any script, the
 * class an address number is made of — not `\p{N}`, whose superscript and
 * numeric forms (`¹`, `½`) are footnote markers here, not second addresses
 * (A2). The dash family is every joiner the number token absorbs: `-`, U+2010,
 * U+2011, U+2012, en dash, em dash, horizontal bar and the minus sign.
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

/** One format character, stateless (no `g`, so no `lastIndex`). */
const INVISIBLE_FORMATTING_CHAR = /\p{Cf}/u;

/** Drop the invisible formatting characters from a label or an answer. */
export function stripInvisibleFormatting(text: string): string {
  return text.replace(INVISIBLE_FORMATTING, "");
}

/**
 * The same drop as {@link stripInvisibleFormatting}, carrying the **offset
 * policy** a scan of the stripped text needs (review A3): `offsets[i]` is the
 * index in `text` of the character at `i` in the returned string, plus a final
 * sentinel at `text.length`. The scan reads the stripped text — so the two
 * sides of the comparison read the same characters and a format character
 * cannot hide a citation from the ungrounded scan — and maps each match back
 * through this array, so a span still points at where the draft wrote it. An
 * end maps to the next surviving character, so dropped characters inside the
 * match stay inside the mapped span the reviewer pre-gate masks.
 */
export function stripInvisibleFormattingWithOffsets(text: string): {
  text: string;
  offsets: number[];
} {
  let stripped = "";
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (INVISIBLE_FORMATTING_CHAR.test(character)) continue;
    stripped += character;
    offsets.push(index);
  }
  offsets.push(text.length);
  return { text: stripped, offsets };
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
 *   *grounded* answer into a refusal. Each rule mirrors the separator its own
 *   grammar makes **mandatory**, so it never rewrites a spelling the scan
 *   cannot see: the `QS` rule requires the grammar's dot-or-space, leaving the
 *   grammar-excluded `QS2:255` alone (review A2 — that spelling stays a
 *   recorded residual, not a fold), and the `HR` rule requires a following
 *   whitespace, so an ordinary word ending in "HR" is never touched.
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
    .replace(/\bQ\.?S(?:\.|\s)\s*/g, "QS. ")
    .replace(/\bHR\.?(?=\s)/g, "HR.")
    .replace(/\bno\.\s*/g, "no. ")
    .replace(/\bJilid\s+/g, "Jilid ")
    .replace(/\bHal\.\s*/g, "Hal. ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*:\s*/g, ":");
}
