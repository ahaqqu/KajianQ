import { addressAtStart } from "./chat-citation-grammar";

/**
 * How a label that **begins** with a citation grammar reduces for comparison:
 * the address that grammar identified (reviews A1/A2), and whether the tail is
 * a dash-joined number the label must keep whole (the A3 precision-for-safety
 * trade-off, {@link DASH_JOINED_NUMBER_TAIL}).
 *
 * This is the reduction half of the subject `chat-citation-grammar` declares:
 * that module owns the grammars and the address inside each match, this one owns
 * what a match reduces to before `chat-citation-spelling` canonicalizes the
 * spelling and `chat-citation-validator` compares it. Split out only for the
 * 300-line agentic limit, the same way the rest of the citation family was — one
 * subject, no new seam — and internal to the domain pack: its one consumer is
 * `chat-citation-normalize`.
 */

/**
 * A dash joined to the address and followed by a DECIMAL DIGIT —
 * `… no. 5010—5011`, `… no. 5010–5011`, `… no. 5010-3`, `… no. 5010—٥٠١١`,
 * `QS. 2:255—256` on the Quran side, and the **spaced** spelling
 * `QS. 2:255 - 256` / `HR. Bukhari no. 5010 - 5011` (review R5 of the fix
 * round) — is kept whole instead of being reduced to its first address. This is
 * a deliberate **precision-for-safety trade-off** (review A3), not an
 * oversight:
 *
 * - The dash family is the product's range joiner, so the compound may carry a
 *   SECOND address. Reducing it to `… no. 5010` would validate the first and
 *   silently drop the second — an unretrieved `no. 5011` would ride in on
 *   `no. 5010`'s grounding, and `QS. 2:256` on `QS. 2:255`'s.
 * - Horizontal whitespace around the joiner is part of that same shape (R5):
 *   while the dash had to be glued to the first number, a spaced range
 *   normalised down to its head — the spaced twin of the hole A2 closed. A
 *   newline is not tolerated, so a joiner cannot pull a number across a line.
 * - One rule covers both grammars because both feed it the same shape: the
 *   pattern absorbs the dash-joined tail, `addressOf` names the head, and the
 *   tail is what this constant tests. The Quran pattern grew that absorption in
 *   #264, where it used to stop at the first verse and ground on it alone.
 * - The cost is real: `… 5010—5011` is refused even when BOTH addresses were
 *   retrieved, and digit-glued or digit-spaced prose (`… 5010—3 kali sehari`,
 *   `… 5010 - 3 kali sehari`) is refused with it. Fail-closed is the safe
 *   direction for a safety-critical gate (SPECS §2.2).
 * - The follow-up A3 recorded **has landed for the Quran grammar** (ADR-0049,
 *   #274): a grammar whose `addressesOf` is declared — the read
 *   `declaresAddressList` makes at the comparison site, never a test of the
 *   declaration's shape (#449) — is checked address-by-address, so
 *   `QS. 2:255—256` and its spaced spelling ground exactly when both verses are
 *   retrieved and still refuse when either is missing. Keeping the label whole
 *   is now only the **display** and refusal-report form, and the boundary this
 *   constant still is for a grammar that declares no address list — the hadith
 *   number today, whose spaced *label* also keeps whole and refuses (the #264
 *   A3 cost; its draft-side spaced form is a recorded exclusion on the pattern).
 *
 * The class after the dash is `\p{Nd}` — a decimal digit of any script, the
 * class an address number is made of — not `\p{N}`, whose superscript and
 * numeric forms (`¹`, `½`) are footnote markers here, not second addresses
 * (A2); the class around it is `\p{Cf}` (glue, as in the grammar's own tail)
 * plus horizontal whitespace (space, tab). The dash family is every joiner the
 * number token absorbs: `-`, U+2010, U+2011, U+2012, en dash, em dash,
 * horizontal bar and the minus sign.
 */
const DASH_JOINED_NUMBER_TAIL = /^[\p{Cf} \t]*[-‐‑‒–—―−][\p{Cf} \t]*\p{Nd}/u;

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
