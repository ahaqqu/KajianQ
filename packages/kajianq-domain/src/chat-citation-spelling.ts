/**
 * How a citation address is **spelled** in the comparison form: the characters
 * and separators it compares in. Which address a label carries is the grammar's
 * `addressOf`; whether it is grounded is `chat-citation-validator`'s.
 */

/**
 * Invisible formatting (`\p{Cf}`) carries no address information but splits the
 * digit tokens around it, so `no. 50\u200c10` must compare as `no. 5010`.
 * Reached through a function, never a shared `g` regex: `lastIndex` state would
 * make the gate order-dependent.
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
 * policy** a scan of the stripped text needs: `offsets[i]` is the index in
 * `text` of the character at `i` in the returned string, plus a final sentinel
 * at `text.length`, so each match maps back to where the draft wrote it and
 * dropped characters inside the match stay inside the mapped span.
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
 * rendering variant of the ASCII digits the corpus labels carry, so they fold to
 * ASCII. Other blocks stay unfolded — a general fold needs a per-block zero
 * table — leaving them recognised and refused (posture on `CITATION_GRAMMARS`).
 */
const FULLWIDTH_DIGITS = /[\uFF10-\uFF19]/g;

/** Fold the fullwidth digit block to the ASCII digits the corpus labels use. */
export function foldAddressDigits(text: string): string {
  return text.replace(FULLWIDTH_DIGITS, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
  );
}

/**
 * Canonicalize a citation's structural separators to the product's forms, so two
 * spellings of one address compare equal: the dotted `Q.S.` variant folds to
 * `QS.`, the bare `QS` / `HR` forms keep their mandatory separator (so the
 * grammar-excluded `QS2:255` is left alone), and separator spacing folds
 * (`no.5010`, `QS. 2: 255`, `Jilid 1,Hal. 102`). Each rule mirrors the separator
 * its own grammar makes mandatory, so the fold never rewrites a spelling the
 * scan cannot see. Folding spacing never changes which digits an address
 * carries, so fabricated addresses stay distinct from retrieved ones.
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
