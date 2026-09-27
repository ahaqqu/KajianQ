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
  () => /\bHR(?:\.|\s)\s*[^\s,.]{1,24}(?:\s+[^\s,.]{1,24}){0,3}\s+no\.\s*[^\s,;.)[\]]+/gi,
  // Kitab (SPECS §2.1): `Al-Umm, Imam Syafi'i, Jilid 1, Hal. 102, Bab …`.
  // Kitab ingestion has not landed, so any such citation is ungrounded by
  // definition today — detecting it is the point, not an accident.
  () => /\bJilid\s+\d+\s*,\s*Hal\.\s*\d+/gi,
];

/**
 * Trailing citation noise: any run of non-address characters at the tail —
 * punctuation, markdown markers/quotes, symbols and whitespace. A citation
 * address always ends in its digits (every grammar ends in `\d+`), and the
 * grammars disagree about which punctuation a match may absorb — the hadith
 * number token stops at `;`, `.`, `)` and `]` but swallows `:`, `—`, `…` and a
 * closing quote — so the same retrieved citation reached the comparison as a
 * different string depending on the prose punctuation that followed it, and a
 * grounded answer was refused (#253).
 *
 * One negated character class, anchored: linear, with no alternation that
 * could match the same tail two ways (model-controlled text makes an ambiguous
 * tail pattern a ReDoS shape).
 */
const TRAILING_CITATION_NOISE = /[^\p{L}\p{N}]+$/u;

/**
 * A closed-up em/en dash joins the citation to the prose that follows it
 * (`… HR. Bukhari no. 5010—ia bersabda …`), and the hadith number token
 * absorbs it into the label. A dash followed by a LETTER is prose and is cut
 * here; one followed by a digit may be a closed-up range (`… no. 5010—5011`),
 * whose second address must stay in the comparison and be refused when no
 * retrieved chunk grounds it — so it is deliberately left whole.
 */
const CLOSED_UP_DASH_BEFORE_PROSE = /[—–](?=\p{L})/u;

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
 * Strip the trailing `(Grade)` suffix the hadith formatter appends. It is only
 * ever the LAST thing in a label: `formatHadithCitation` writes it at the end
 * of the chunk's label, and no draft span can carry one at all — the hadith
 * number token stops at whitespace, so the grammar's match ends at the number.
 * A grade written *after* punctuation therefore cannot occur, and this stays a
 * single anchored pass.
 */
function stripGradeSuffix(label: string): string {
  return label.replace(/\s*\([^()]*\)\s*$/, "");
}

/**
 * Reduce a label to its address by dropping the tail a generator attaches: the
 * grade parenthetical the chunk formatter appends, then the punctuation,
 * markdown or quote noise a draft wraps around it. Both patterns are linear
 * and anchored, and neither can match what the other matched first.
 */
function trimCitationTail(label: string): string {
  return stripGradeSuffix(label).replace(TRAILING_CITATION_NOISE, "").trim();
}

/**
 * Normalize a label for comparison: collapse whitespace, trim, drop the tail
 * (grade suffix, markdown emphasis, prose punctuation), and canonicalize the
 * marker spellings (`Q.S.` and `QS` → `QS.`, `HR` → `HR.`).
 *
 * The tail strip matters because the grammar stops at sentence punctuation but
 * NOT at `*`/`_`/backticks or the punctuation above, so a styled citation
 * (`**HR. Malik no. 18**`) or one written as ordinary prose (`… HR. Bukhari
 * no. 5010: <matn> …`) reached the comparison with its markers attached and
 * was reported UNGROUNDED — a grounded answer refused. The markdown case
 * refused a grounded answer on the first live size-5 smoke (gs-v0-015); the
 * colon case refused gs-v0-001 on staging (#253, trace f417d603-…), where
 * chunk 94d2a731 carried `HR. Bukhari no. 5010` and the draft said
 * `HR. Bukhari no. 5010:`. Both sides of the comparison — the chunk's label
 * and the draft's extracted span — pass through this one function, so closing
 * the tail class here closes both directions at once.
 *
 * Only the TAIL is touched, and only characters no address can end with, so
 * the colon inside `QS. 2:255` and the comma inside `Jilid 1, Hal. 102`
 * survive: a naive `replace(/:.*$/, "")` would erase every Quran citation.
 */
export function normalizeCitationLabel(label: string): string {
  const dashCut = CLOSED_UP_DASH_BEFORE_PROSE.exec(label);
  return canonicalizeMarkers(
    trimCitationTail(
      (dashCut === null ? label : label.slice(0, dashCut.index))
        .replace(/[*_`]+/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  );
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
  for (const makePattern of CITATION_GRAMMARS) {
    for (const match of text.matchAll(makePattern())) {
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
 * The comparison form of a text for grounded-label matching: whitespace
 * collapsed and markers canonicalized, exactly as {@link validateCitations}
 * matches a chunk's label against the answer. Exported so a consumer that must
 * find a grounded citation inside the draft (the reviewer pre-gate's claim
 * spans) compares the same way the gate that declared it grounded did — a
 * second implementation here would let the two disagree about what "the
 * passage states" means.
 */
export function citationMatchText(text: string): string {
  return canonicalizeMarkers(text.replace(/\s+/g, " "));
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
