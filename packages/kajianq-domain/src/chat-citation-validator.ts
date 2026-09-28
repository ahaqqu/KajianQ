import type { Chunk } from "@app/rag-core";
import { addressesNamedBy } from "./chat-citation-grammar";
import {
  citationCandidatesIn,
  citationSpansIn,
  normalizeCitationLabel,
} from "./chat-citation-normalize";
import {
  canonicalizeCitationSpelling,
  foldAddressDigits,
  stripInvisibleFormatting,
} from "./chat-citation-spelling";

// Re-exported so the gate's public surface (the domain barrel, the reviewer
// pre-gate's claim spans, the eval scorer's injected grammar) is unchanged by
// the split: the scan and the comparison form are one subject and one import
// path, however many files the 300-line cap distributes them across.
export { citationCandidatesIn, citationSpansIn, normalizeCitationLabel };

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
 *
 * **A citation that names a LIST of addresses is checked address by address
 * (ADR-0049).** The Quran range is such a form: `QS. 3:1-2` names `QS. 3:1`
 * *and* `QS. 3:2`, so it grounds exactly when the retrieved labels hold every
 * one of them — and still refuses when only the head, only the tail, or
 * neither was retrieved. The list comes from the grammar that declared it
 * (`addressesNamedBy`), never from splitting a dash at this site: a grammar
 * with no list-valued form names one address and its dash-joined compound
 * stays the opaque whole it was (#264's A3 boundary, unchanged for hadith).
 * The candidate label itself is untouched, so the refusal reason, the
 * reviewer pre-gate's claim spans and the citation the user reads keep naming
 * what the draft named.
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
    // ADR-0049: every address the citation's own grammar declares it names
    // must be present. One declared address is the ordinary case already
    // covered above; the check only ever ADDS a requirement, never drops one,
    // so it cannot ground a citation the whole-label rule refused.
    const named = addressesNamedBy(candidate).map(canonicalizeCitationSpelling);
    if (named.length > 1 && named.every((address) => known.has(address))) continue;
    if (!ungrounded.includes(candidate)) ungrounded.push(candidate);
  }
  return { grounded, ungrounded };
}
