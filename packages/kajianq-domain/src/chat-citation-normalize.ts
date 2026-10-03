import { CITATION_GRAMMARS, reduceCitationLabel } from "./chat-citation-grammar";
import {
  canonicalizeCitationSpelling,
  foldAddressDigits,
  stripInvisibleFormatting,
  stripInvisibleFormattingWithOffsets,
} from "./chat-citation-spelling";

/**
 * The comparison form of a citation label, and the grammar scan that finds the
 * citation-shaped spans inside a draft — the half of the gate that turns text
 * into normalized addresses, split from `chat-citation-validator` (which
 * decides what a grounded citation IS) for the 300-line agentic cap.
 *
 * Everything here is pure and effect-free; the normalization ORDER is
 * load-bearing and is documented at {@link normalizeCitationLabel}, because the
 * two directions of the gate must normalize both sides identically or a
 * grounded citation is refused for its spelling.
 */
/**
 * Trailing citation noise: any run of non-address characters at the tail —
 * punctuation, markdown markers/quotes, symbols and whitespace. This is the
 * **fallback** rule, for labels that do not begin with a citation grammar (a
 * full Kitab chunk label carries its work and author before `Jilid …`): such a
 * label is not an address with a tail, so it is cleaned lexically. A label
 * that does begin with a grammar is reduced to the address that grammar
 * identified instead — see {@link normalizeCitationLabel}.
 *
 * One negated character class, anchored: linear, with no alternation that
 * could match the same tail two ways (model-controlled text makes an ambiguous
 * tail pattern a ReDoS shape).
 */
const TRAILING_CITATION_NOISE = /[^\p{L}\p{N}]+$/u;
/**
 * Strip the trailing `(Grade)` suffix the hadith formatter appends. It is
 * reachable for a label that does **not** begin with a citation grammar — a
 * full Kitab chunk label (`Al-Umm, … , Jilid 1, Hal. 102 (Sahih)`) is the shape
 * it exists for — **or for a grammar-initial label that is kept whole**: a
 * dash-joined compound reduces to itself, so this pass is what removes the
 * grade from `HR. Bukhari no. 5010—5011 (Dhaif)` (executed). Every other
 * grammar-initial label is reduced to its grammar's address before this pass is
 * reached, and that reduction already removes the grade: on the chunk side
 * `formatHadithCitation` writes `HR. X no. N (Grade)`, whose address is the
 * number word after `no.`, so `reduceCitationLabel("HR. Ibnu Majah no. 224
 * (Dhaif)")` returns `{address: "HR. Ibnu Majah no. 224", keepWhole: false}` and
 * this anchored pass never sees it. The earlier rewording stopped at "does not
 * begin with a citation grammar", which the kept-whole compound falsifies
 * (review B2); both paths are executed in the unit test.
 *
 * On the draft side only the **spaced** form is out of reach: the grammar's
 * number token stops at whitespace, so `HR. X no. 573 (Sahih)` and
 * `HR. X no. 573: (Sahih)` never enter a span. The **glued** form does:
 * `citationSpansIn("HR. Bukhari no. 573(Sahih) …")` yields the span
 * `HR. Bukhari no. 573(Sahih` (the token absorbs `(`, stops at `)`), which is a
 * real draft span carrying grade text. That shape is reduced by the
 * grammar-address rule in {@link normalizeCitationLabel}. (An earlier docstring
 * claimed no draft span could carry a grade at all — false, and the glued shape
 * it missed false-refused a grounded citation; review B2/A2. Review #264 then
 * found the chunk-side clause of the same docstring stale in the same way.)
 */
function stripGradeSuffix(label: string): string {
  return label.replace(/\s*\([^()]*\)\s*$/, "");
}
/**
 * Reduce a label that does **not** begin with a citation grammar to its
 * address-adjacent form: drop the grade parenthetical the chunk formatter
 * appends, then the punctuation, markdown or quote noise a draft wraps around
 * it. Both patterns are linear and anchored, and neither can match what the
 * other matched first. Labels that DO begin with a grammar are reduced to that
 * grammar's address instead — the tail there is whatever the grammar's token
 * absorbed, and only the grammar knows whether a given tail character is
 * address or noise.
 */
function trimCitationTail(label: string): string {
  return stripGradeSuffix(label).replace(TRAILING_CITATION_NOISE, "").trim();
}
/**
 * Normalize a label for comparison: collapse whitespace, drop markdown
 * emphasis and invisible formatting, fold the fullwidth digit block, reduce the
 * label to the **address its own citation grammar identifies**, then
 * canonicalize the address's separator spelling.
 *
 * The reduction is grammar-driven rather than a punctuation rule, because a
 * tail cannot be recognized by its characters alone (review A2): the footnote
 * `HR. Bukhari no. 5010:1` must reduce to `HR. Bukhari no. 5010`, while
 * `QS. 2:255` must keep its colon and both numbers. No trailing-character rule
 * can separate those two — the hadith grammar already knows its address ends
 * at the number word after `no.`, and the Quran grammar knows its address IS
 * the `surah:ayah` pair. So each grammar names its address (`addressOf` in
 * `chat-citation-grammar`) and {@link reduceCitationLabel} trims the match to
 * it. That single rule also closes the rest of the tail family at once:
 * `… no. 5010:` (#253), `… no. 5010—ia` / `-ia` / `‒ia` / `―ia` (A1),
 * `… no. 5010:1`, `… no. 5010¹`, `… no. 5010(Sahih` (A2), and the rest of the
 * Unicode classes the property sweeps (B1).
 *
 * Two things survive the reduction on purpose, both fail-closed (the reasons
 * are on their declarations in `chat-citation-grammar`):
 *
 * - a dash joined to a number, kept whole — the A3 precision-for-safety
 *   trade-off, with its cost and its follow-up, now covering the Quran
 *   compound (`QS. 2:255—256`) as well as the hadith one (#264);
 * - letters and digits glued straight onto the number, which are part of the
 *   address token itself, so `… no. 5010a` and `… no. 50102` stay distinct
 *   from `… no. 5010` instead of grounding on it.
 *
 * Labels that do not begin with a grammar keep the lexical strip
 * ({@link trimCitationTail}): the grade parenthetical the chunk formatter
 * appends, then the trailing punctuation.
 *
 * Only the TAIL is touched, so the colon inside `QS. 2:255` and the comma
 * inside `Jilid 1, Hal. 102` survive: a naive `replace(/:.*$/, "")` would
 * erase every Quran citation.
 */
export function normalizeCitationLabel(label: string): string {
  const flattened = foldAddressDigits(stripInvisibleFormatting(label.replace(/[*_`]+/g, "")))
    .replace(/\s+/g, " ")
    .trim();
  const reduction = reduceCitationLabel(flattened);
  const reduced =
    reduction === null || reduction.keepWhole ? trimCitationTail(flattened) : reduction.address;
  return canonicalizeCitationSpelling(reduced);
}
/**
 * Every citation-shaped span in the text, normalized and de-duplicated in
 * first-appearance order. Grammar matches inside brackets are found by the
 * same scan (`[QS. 2:255]` matches `\bQS\.`), so no separate bracket rule is
 * needed — and no non-citation bracketed text is picked up.
 */
export function citationCandidatesIn(text: string): string[] {
  return scanCitations(text).map((citation) => citation.label);
}
/**
 * The same scan as {@link citationCandidatesIn}, but carrying each span's
 * offsets in the original text and ordered by **position in the text** rather
 * than by grammar (the candidate list is grammar-major: all Quran matches
 * before all hadith matches, whatever their order in the draft).
 *
 * The offset+position form is what a consumer that must locate a groundable
 * citation *inside* the draft needs — the reviewer pre-gate keys its judgment
 * by citation position (ADR-0042 adoption) and must not split a claim span in
 * the middle of a citation. Both exports read the one scan, so the grammar,
 * the normalization, and the de-duplication rule cannot drift between them.
 */
export function citationSpansIn(text: string): { start: number; end: number; label: string }[] {
  return scanCitations(text)
    .map((citation) => ({ ...citation }))
    .sort((a, b) => a.start - b.start);
}
/**
 * The one grammar scan behind both citation-list exports (first-seen wins).
 *
 * The scan reads the **stripped** text, not the raw draft (review A3): the
 * ungrounded direction used to match raw characters while the comparison form
 * dropped `\p{Cf}`, so a fabricated `HR. Bukhari no\u200c. 99999` was invisible
 * to the gate and passed unseen. Both sides now read the same characters, and
 * {@link stripInvisibleFormattingWithOffsets} carries the offset policy that
 * keeps each span pointing at where the draft wrote it.
 *
 * **Recorded residual (#264 review A3).** Two spellings stay outside every
 * grammar and so still pass unseen — the fail-open direction the digit posture
 * on {@link CITATION_GRAMMARS} promises not to take. They are recorded, not
 * closed, because closing either is a grammar widening:
 *
 * - `QS9:99` (no separator between marker and address) — round-3 A1 required
 *   one, and {@link canonicalizeCitationSpelling} now mirrors that exclusion
 *   instead of folding a spelling the scan cannot see (review A2);
 * - `HR. Bukhari no 99999` (dot-less address marker) — the hadith pattern
 *   requires `no.`.
 *
 * Both rows are pinned in the unit test so the next hunt does not re-find them.
 */
function scanCitations(text: string): { start: number; end: number; label: string }[] {
  const found: { start: number; end: number; label: string }[] = [];
  const seen = new Set<string>();
  const { text: scanned, offsets } = stripInvisibleFormattingWithOffsets(text);
  for (const grammar of CITATION_GRAMMARS) {
    for (const match of scanned.matchAll(grammar.pattern())) {
      const label = normalizeCitationLabel(match[0]);
      if (label === "" || seen.has(label)) continue;
      seen.add(label);
      const start = offsets[match.index] ?? text.length;
      const end = offsets[match.index + match[0].length] ?? text.length;
      found.push({ start, end, label });
    }
  }
  return found;
}
