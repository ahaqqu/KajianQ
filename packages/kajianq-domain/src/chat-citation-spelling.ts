/**
 * How a citation address is **spelled** in the comparison form — the second
 * half of the subject `chat-citation-grammar` owns (that module declares the
 * grammars and the address inside each match; this one says what characters
 * and separators the address compares in). Split from it only to stay inside
 * the 300-line agentic limit, the same way `chat-citation-grammar` itself was
 * split from the validator: one subject, one step later, no new seam.
 *
 * Nothing here decides **which** address a label carries — that is the
 * grammar's `addressOf` — and nothing here decides whether a citation is
 * grounded: `chat-citation-validator` owns both the normalization order and
 * the comparison.
 */

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
 * depends on call order is no gate (rationale on `CITATION_GRAMMARS`).
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
 * never silently dropped (the posture is stated on `CITATION_GRAMMARS`).
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
 * - **Address spacing** (#264): every grammar writes its separators with
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
