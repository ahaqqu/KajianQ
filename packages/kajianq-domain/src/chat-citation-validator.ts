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
  // Quran: `QS. 2:255` or `QS. Al-Baqarah:255` (surah numeric or named).
  () => /\bQS\.\s*[^\s:,[\]()]+\s*:\s*\d+/gi,
  // Hadith: `HR. Bukhari no. 573` / `HR. Ibn Majah no. 224 (Dhaif)`.
  // Collection names may be multi-word ("Abu Dawud", "Ibn Majah").
  () => /\bHR\.\s*[^\s,]+(?:\s+[^\s,]+)?\s+no\.\s*[^\s,;.)]+/gi,
  // Kitab (SPECS §2.1): `Al-Umm, Imam Syafi'i, Jilid 1, Hal. 102, Bab …`.
  // Kitab ingestion has not landed, so any such citation is ungrounded by
  // definition today — detecting it is the point, not an accident.
  () => /\bJilid\s+\d+\s*,\s*Hal\.\s*\d+/gi,
];

/** Strip the trailing `(Grade)` suffix the hadith formatter appends. */
function stripGradeSuffix(label: string): string {
  return label.replace(/\s*\([^()]*\)\s*$/, "").trim();
}

/** Normalize a label for comparison: collapse whitespace, trim, drop grade. */
export function normalizeCitationLabel(label: string): string {
  return stripGradeSuffix(label).replace(/\s+/g, " ").trim();
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
  const normalizedAnswer = answer.replace(/\s+/g, " ");
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
