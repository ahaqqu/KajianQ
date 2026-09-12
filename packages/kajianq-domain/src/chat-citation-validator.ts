import type { Chunk } from "@app/rag-core";

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
 * The citation grammars the product renders (SPECS §2.1). Literal regexes, not
 * strings compiled on the fly: a constructed regex is the ReDoS shape the
 * security scan blocks, and there is nothing dynamic here to justify it.
 *
 * Each entry is a **factory** returning a fresh regex, because a shared
 * module-level `g` regex carries `lastIndex` state between calls — which would
 * make validation order-dependent, and a non-deterministic safety gate is no
 * gate. Extending the validator for a new source type is a one-line addition.
 */
const CITATION_GRAMMARS: readonly (() => RegExp)[] = [
  // Quran: `QS. 2:255` / `Q.S. 2:255` (both dotted spellings Indonesian prose
  // uses) or `QS. Al-Baqarah:255` (surah numeric or named). The marker closes
  // with a dot OR a space (round-3 A1): the dot-less `QS 2:255` is a common
  // model spelling, and requiring the dot let a fabricated citation bypass the
  // gate entirely. Requiring *some* separator keeps `QS2:255` (no boundary
  // between marker and address) out of the grammar, as before.
  () => /\bQ\.?S(?:\.|\s)\s*[^\s:,[\]()]+\s*:\s*\d+/gi,
  // Hadith: `HR. Bukhari no. 573` / `HR. Ibn Majah no. 224 (Dhaif)`, and the
  // dot-less `HR Bukhari no. 573` (round-3 A1, same rationale as the Quran
  // marker). Collection names may be multi-word ("Abu Dawud", "Ibn Majah")
  // and the long forms a model actually writes carry a collection-type prefix
  // ("Sunan Abu Dawud", "Sunan an Nasai"), so up to four tokens are
  // tolerated. Token classes exclude `.` and `,` so the match cannot run
  // across a sentence boundary or swallow a list, and both the token length
  // and the repetition count are bounded — no nested unbounded quantifier,
  // so the pattern stays linear (ReDoS-safe) as required. The trailing
  // number token also skips brackets (#11, found by the citation-payload
  // derivation): `[HR. Malik no. 18]` used to capture a phantom `…no. 18]`
  // span that normalized to nothing a chunk grounds — a false UNGROUNDED,
  // i.e. a refused grounded answer; the Quran address already skipped them.
  () => /\bHR(?:\.|\s)\s*[^\s,.]{1,24}(?:\s+[^\s,.]{1,24}){0,3}\s+no\.\s*[^\s,;.)\[\]]+/gi,
  // Kitab (SPECS §2.1): `Al-Umm, Imam Syafi'i, Jilid 1, Hal. 102, Bab …`.
  // Kitab ingestion has not landed, so any such citation is ungrounded by
  // definition today — detecting it is the point, not an accident.
  () => /\bJilid\s+\d+\s*,\s*Hal\.\s*\d+/gi,
];

/** Strip the trailing `(Grade)` suffix the hadith formatter appends. */
function stripGradeSuffix(label: string): string {
  return label.replace(/\s*\([^()]*\)\s*$/, "").trim();
}

/**
 * Canonicalize the citation markers' spelling to the product's `QS.` / `HR.`
 * forms: the dotted `Q.S.` variant, and — since the grammars accept the
 * dot-less spellings (round-3 A1) — the bare `QS` / `HR` forms. A model that
 * writes `Q.S. 2:255` or `QS 2:255` for a chunk labeled `QS. 2:255` is citing
 * the same address, and treating it as a different one would turn a *grounded*
 * answer into a refusal. Fabricated addresses are unaffected — `Q.S. 9:99` and
 * `QS 9:99` still normalize to `QS. 9:99`, which no retrieved chunk grounds.
 *
 * The lookahead requires a following whitespace: a marker is only ever
 * canonicalized when an address follows it (the grammars guarantee one), so an
 * ordinary word ending in "QS"/"HR" is never touched.
 */
function canonicalizeMarkers(text: string): string {
  return text.replace(/\bQ\.?S\.?(?=\s)/g, "QS.").replace(/\bHR\.?(?=\s)/g, "HR.");
}

/**
 * Normalize a label for comparison: collapse whitespace, trim, drop grade,
 * strip markdown emphasis, and canonicalize the marker spellings (`Q.S.` and
 * `QS` → `QS.`, `HR` → `HR.`).
 *
 * The markdown-emphasis strip matters because the grammar stops at sentence
 * punctuation but NOT at `*`/`_`/backticks, so a bolded citation
 * (`**HR. Malik no. 18**`) reached the comparison with its markers attached
 * and was reported UNGROUNDED. That false positive refused a grounded
 * answer on the first live size-5 smoke (gs-v0-015).
 */
export function normalizeCitationLabel(label: string): string {
  return canonicalizeMarkers(
    stripGradeSuffix(label)
      .replace(/[*_`]+/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/**
 * Every citation-shaped span in the text, normalized and de-duplicated in
 * first-appearance order. Grammar matches inside brackets are found by the
 * same scan (`[QS. 2:255]` matches `\bQS\.`), so no separate bracket rule is
 * needed — and no non-citation bracketed text is picked up.
 */
export function citationCandidatesIn(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const makePattern of CITATION_GRAMMARS) {
    for (const match of text.matchAll(makePattern())) {
      const label = normalizeCitationLabel(match[0]);
      if (label === "" || seen.has(label)) continue;
      seen.add(label);
      found.push(label);
    }
  }
  return found;
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
  const normalizedAnswer = canonicalizeMarkers(answer.replace(/\s+/g, " "));
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
