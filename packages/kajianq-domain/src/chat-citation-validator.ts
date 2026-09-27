import type { Chunk } from "@app/rag-core";
import {
  CITATION_GRAMMARS,
  canonicalizeCitationSpelling,
  foldAddressDigits,
  reduceCitationLabel,
  stripInvisibleFormatting,
} from "./chat-citation-grammar";

/**
 * Deterministic citation validator (spec §3.3 step 7, ticket #10): every
 * citation in the answer must correspond to a chunk actually retrieved in the
 * same request. Pure string work — no LLM, no engine-domain leakage; the
 * label formats are data on the chunks.
 *
 * Two directions are checked, and both matter:
 *
 * - **Grounded**: which retrieved chunks' citation labels the answer cites.
 * - **Ungrounded**: which citation-shaped spans the answer carries that exist
 *   in no retrieved chunk. This is the safety-critical direction — a
 *   fabricated citation (`QS. 9:99`, `HR. Bukhari no. 99999`) is exactly the
 *   silent failure this validator exists to catch, and it must be caught
 *   whether the model wrapped it in brackets or wrote it in prose.
 *
 * Detection is deliberately **grammar-driven, not bracket-driven**: only spans
 * matching the product's citation grammar count as citation attempts. A
 * generic bracketed word (`[Peringatan]`, `[not found]`) is not a citation —
 * treating it as one would convert every dhaif-warning answer into a refusal,
 * a false positive that would train reviewers to distrust the gate. The
 * earlier bracket-only scan had exactly this hole in reverse: it saw
 * `[QS. 9:99]` but missed the same fabricated citation written in prose.
 *
 * Unverifiable forms are refused, never waved through: a Quran citation
 * written with a surah *name* (`QS. Al-Baqarah:255`) cannot be checked against
 * the corpus's numeric labels, so it is reported ungrounded. The safe
 * direction is a refusal, and the system prompt instructs the model to cite
 * "exactly as its source label" (which the assembler renders verbatim), so the
 * model has everything it needs to stay verifiable.
 */

/** Citation labels carried by each retrieved chunk's metadata. */
export function citationLabelsOf(chunk: Chunk): string[] {
  const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
  const citation = meta["citation"];
  if (typeof citation === "string" && citation.trim() !== "") return [citation.trim()];
  if (Array.isArray(citation)) {
    return citation.filter((c): c is string => typeof c === "string" && c.trim() !== "");
  }
  return [];
}

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
 * reachable only for a label that does **not** begin with a citation grammar —
 * a full Kitab chunk label (`Al-Umm, … , Jilid 1, Hal. 102 (Sahih)`) is the
 * shape it exists for. Every grammar-initial label is reduced to its grammar's
 * address before this pass is reached, and that reduction already removes the
 * grade: on the chunk side `formatHadithCitation` writes
 * `HR. X no. N (Grade)`, whose address is the number word after `no.`, so
 * `reduceCitationLabel("HR. Ibnu Majah no. 224 (Dhaif)")` returns
 * `{address: "HR. Ibnu Majah no. 224", keepWhole: false}` and this anchored
 * pass never sees it.
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

/** The one grammar scan behind both citation-list exports (first-seen wins). */
function scanCitations(text: string): { start: number; end: number; label: string }[] {
  const found: { start: number; end: number; label: string }[] = [];
  const seen = new Set<string>();
  for (const grammar of CITATION_GRAMMARS) {
    for (const match of text.matchAll(grammar.pattern())) {
      const label = normalizeCitationLabel(match[0]);
      if (label === "" || seen.has(label)) continue;
      seen.add(label);
      const start = match.index;
      found.push({ start, end: start + match[0].length, label });
    }
  }
  return found;
}

/**
 * The comparison form of a text for grounded-label matching: invisible
 * formatting dropped, fullwidth digits folded, whitespace collapsed and the
 * address separators canonicalized, exactly as {@link validateCitations}
 * matches a chunk's label against the answer. Exported so a consumer that must
 * find a grounded citation inside the draft (the reviewer pre-gate's claim
 * spans) compares the same way the gate that declared it grounded did — a
 * second implementation here would let the two disagree about what "the
 * passage states" means.
 */
export function citationMatchText(text: string): string {
  return canonicalizeCitationSpelling(
    foldAddressDigits(stripInvisibleFormatting(text)).replace(/\s+/g, " "),
  );
}

/**
 * Check the draft's answer: which of the retrieved chunks' citation labels
 * appear in the text (`grounded`), and which citation-shaped spans in the
 * text exist in no retrieved chunk (`ungrounded`).
 *
 * Matching is on the normalized form, so a model that reflows whitespace or
 * appends a grade parenthetical is not falsely accused; and a retrieved label
 * whose text the answer extends (the model added `(Sahih)` to an ungraded
 * chunk) still counts as grounded.
 */
export function validateCitations(
  answer: string,
  chunks: readonly Chunk[],
): { grounded: string[]; ungrounded: string[] } {
  const known = new Set<string>();
  for (const chunk of chunks) {
    for (const label of citationLabelsOf(chunk)) {
      const normalized = normalizeCitationLabel(label);
      if (normalized !== "") known.add(normalized);
    }
  }
  // The answer is canonicalized the same way as the labels, so a grounded
  // address written with the dotted marker (`Q.S. 2:255`) or the dot-less
  // spelling (`QS 2:255`) for a `QS. 2:255` chunk still counts as grounded
  // provenance rather than vanishing from the review trace's `grounded` list.
  const normalizedAnswer = citationMatchText(answer);
  const grounded: string[] = [];
  for (const label of known) {
    if (normalizedAnswer.includes(label)) grounded.push(label);
  }
  const ungrounded: string[] = [];
  for (const candidate of citationCandidatesIn(answer)) {
    if (known.has(candidate)) continue;
    // The answer may extend a known label with a grade the chunk did not
    // carry (`HR. Bukhari no. 573` → `… (Sahih)`); the address is what must
    // be grounded, so a known-label prefix counts.
    if ([...known].some((k) => candidate.startsWith(`${k} `))) continue;
    if (!ungrounded.includes(candidate)) ungrounded.push(candidate);
  }
  return { grounded, ungrounded };
}
