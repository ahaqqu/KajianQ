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
 * One citation grammar: a fresh matcher, plus the extractor that names the
 * **address inside that matcher's own match**.
 *
 * Separating the two is the fix for review A1/A2. A grammar's token class
 * absorbs whatever trails the address until it meets a character it excludes
 * (whitespace, a comma, a closing bracket), and that absorbed tail is not
 * address: the footnote in `HR. Bukhari no. 5010:1`, the superscript in
 * `… no. 5010¹`, the glued grade in `… no. 5010(Sahih` and the prose in
 * `… no. 5010-ia` are one shape — characters the token took along with it.
 * Where an address ends is not decidable from the tail's characters (a
 * trailing-character rule cannot reduce `5010:1` without also eating the verse
 * digits of `QS. 2:255`), but each grammar already knows its own address, and
 * `addressOf` is where it says so. See {@link normalizeCitationLabel}.
 */
interface CitationGrammar {
  /** A fresh matcher per call (rationale on {@link CITATION_GRAMMARS}). */
  readonly pattern: () => RegExp;
  /**
   * The address inside this grammar's match, or `null` when the match carries
   * none to reduce to (a hadith number that is not ASCII-digit-led). Such a
   * match is still a citation attempt and is still refused — it simply has no
   * address core, so the lexical tail strip owns it.
   */
  readonly addressOf: (match: RegExpExecArray) => string | null;
}

/**
 * The address at the head of a hadith match's number slot: the ASCII-digit-led
 * number word — `HR. Bukhari no. 5010` out of `… no. 5010:1`, `… no. 5010¹`
 * and `… no. 5010(Sahih`. Letters and further digits continue the number
 * because they make a **different** address: `no. 5010a` and `no. 50102` must
 * never reduce to `no. 5010`, or a wrong or fabricated sub-number would ride
 * in on a retrieved one's grounding (fail-closed).
 */
const HADITH_ADDRESS = /^(.*?no\.\s*\d[\p{L}\p{Nd}]*)/u;

/**
 * The citation grammars the product renders (SPECS §2.1). Literal regexes, not
 * strings compiled on the fly: a constructed regex is the ReDoS shape the
 * security scan blocks, and there is nothing dynamic here to justify it.
 *
 * Each entry is a **factory** returning a fresh regex, because a shared
 * module-level `g` regex carries `lastIndex` state between calls — which would
 * make validation order-dependent, and a non-deterministic safety gate is no
 * gate. Extending the validator for a new source type is one addition here.
 */
const CITATION_GRAMMARS: readonly CitationGrammar[] = [
  // Quran: `QS. 2:255` / `Q.S. 2:255` (both dotted spellings Indonesian prose
  // uses) or `QS. Al-Baqarah:255` (surah numeric or named). The marker closes
  // with a dot OR a space (round-3 A1): the dot-less `QS 2:255` is a common
  // model spelling, and requiring the dot let a fabricated citation bypass the
  // gate entirely. Requiring *some* separator keeps `QS2:255` (no boundary
  // between marker and address) out of the grammar, as before. The match IS
  // the address: the grammar ends at the verse digits, so the colon and both
  // numbers are address, never tail — review A2's counter-case to the
  // footnote.
  {
    pattern: () => /\bQ\.?S(?:\.|\s)\s*[^\s:,[\]()]+\s*:\s*\d+/gi,
    addressOf: (match) => match[0],
  },
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
  // The match spans address + absorbed tail; `HADITH_ADDRESS` names the
  // address inside it (review A1/A2).
  {
    pattern: () =>
      /\bHR(?:\.|\s)\s*[^\s,.]{1,24}(?:\s+[^\s,.]{1,24}){0,3}\s+no\.\s*[^\s,;.)[\]]+/gi,
    addressOf: (match) => HADITH_ADDRESS.exec(match[0])?.[1] ?? null,
  },
  // Kitab (SPECS §2.1): `Al-Umm, Imam Syafi'i, Jilid 1, Hal. 102, Bab …`.
  // Kitab ingestion has not landed, so any such citation is ungrounded by
  // definition today — detecting it is the point, not an accident. The match
  // IS the address: the work and author a full Kitab label carries precede it
  // and are not part of it.
  {
    pattern: () => /\bJilid\s+\d+\s*,\s*Hal\.\s*\d+/gi,
    addressOf: (match) => match[0],
  },
];

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
 * A dash joined to the address and followed by a DECIMAL DIGIT — `… no. 5010—5011`,
 * `… no. 5010–5011`, `… no. 5010-3`, `… no. 5010—٥٠١١` — is kept whole instead
 * of being reduced to its first address. This is a deliberate
 * **precision-for-safety trade-off** (review A3), not an oversight:
 *
 * - The dash family is the product's closed-up range joiner, so the compound
 *   may carry a SECOND address. Reducing it to `… no. 5010` would validate
 *   only the first address and silently drop the second from the comparison —
 *   an unretrieved `no. 5011` would ride in on `no. 5010`'s grounding.
 * - The cost is real and accepted: `… 5010—5011` is refused even when BOTH
 *   addresses were retrieved, and digit-glued prose (`… 5010—3 kali sehari`)
 *   is refused with it. Fail-closed is the safe direction for a
 *   safety-critical gate (SPECS §2.2).
 * - The follow-up that closes the cost without reopening the hole belongs at
 *   the comparison site in {@link validateCitations}: split the compound into
 *   its two addresses and require each grounded — an unretrieved second
 *   address still refuses, a fully grounded range stops being a false
 *   refusal. Until then this constant is the boundary.
 *
 * The class after the dash is `\p{Nd}` — a decimal digit of any script, the
 * class an address number is made of — not `\p{N}`: a superscript or numeric
 * form (`¹`, `½`, both `\p{No}`) is a footnote marker in this prose, not a
 * second address, and `… no. 5010¹` must reduce like any other footnote tail
 * (A2). The dash family covers every character the number token absorbs as a
 * range joiner: `-`, U+2010, U+2011, U+2012, en dash, em dash, horizontal bar
 * and the minus sign.
 */
const DASH_JOINED_NUMBER_TAIL = /^[-‐‑‒–—―−]\p{Nd}/u;

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
 * Strip the trailing `(Grade)` suffix the hadith formatter appends. On the
 * chunk side it is only ever the LAST thing in a label — `formatHadithCitation`
 * writes `HR. X no. N (Grade)` — and this single anchored pass is what removes
 * it there.
 *
 * On the draft side only the **spaced** form is out of reach: the grammar's
 * number token stops at whitespace, so `HR. X no. 573 (Sahih)` and
 * `HR. X no. 573: (Sahih)` never enter a span. The **glued** form does:
 * `citationSpansIn("HR. Bukhari no. 573(Sahih) …")` yields the span
 * `HR. Bukhari no. 573(Sahih` (the token absorbs `(`, stops at `)`), which is a
 * real draft span carrying grade text. That shape is reduced by the
 * grammar-address rule in {@link normalizeCitationLabel}; this pass never sees
 * it. (An earlier docstring claimed no draft span could carry a grade at all —
 * false, and the glued shape it missed false-refused a grounded citation;
 * review B2/A2.)
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
 * The address a citation grammar identifies at the **start** of a label, or
 * `null` when the label does not begin with one. Only a label that starts with
 * the grammar is an address-with-tail; a grammar match later in the label (the
 * work and author of `Al-Umm, Imam Syafi'i, Jilid 1, Hal. 102`) is not, and
 * the lexical tail rule still owns that label.
 */
function addressAtStart(label: string): string | null {
  for (const grammar of CITATION_GRAMMARS) {
    const match = grammar.pattern().exec(label);
    if (match?.index !== 0) continue;
    const address = grammar.addressOf(match);
    if (address !== null && address !== "") return address;
  }
  return null;
}

/**
 * Normalize a label for comparison: collapse whitespace, strip markdown
 * emphasis, reduce the label to the **address its own citation grammar
 * identifies**, then canonicalize the marker spellings (`Q.S.`/`QS ` → `QS.`,
 * `HR ` → `HR.`).
 *
 * The reduction is grammar-driven rather than a punctuation rule, because a
 * tail cannot be recognized by its characters alone (review A2): the footnote
 * `HR. Bukhari no. 5010:1` must reduce to `HR. Bukhari no. 5010`, while
 * `QS. 2:255` must keep its colon and both numbers. No trailing-character rule
 * can separate those two — the hadith grammar already knows its address ends
 * at the number word after `no.`, and the Quran grammar knows its address IS
 * the `surah:ayah` pair. So each grammar names its address (`addressOf`) and
 * this function trims the match to it. That single rule also closes the rest
 * of the tail family at once: `… no. 5010:` (#253), `… no. 5010—ia` / `-ia` /
 * `‒ia` / `―ia` (A1), `… no. 5010:1`, `… no. 5010¹`, `… no. 5010(Sahih` (A2),
 * `… no. 5010：`, `… no. 5010،` and the rest (B1).
 *
 * Two things survive the reduction on purpose, both fail-closed:
 *
 * - a dash joined to a number, kept whole — the A3 trade-off, with its cost
 *   and its follow-up, on {@link DASH_JOINED_NUMBER_TAIL};
 * - letters and digits glued straight onto the number, which are part of the
 *   address token itself (`HADITH_ADDRESS`), so `… no. 5010a` and
 *   `… no. 50102` stay distinct from `… no. 5010` instead of grounding on it.
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
  const flattened = label
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const address = addressAtStart(flattened);
  if (address === null) return canonicalizeMarkers(trimCitationTail(flattened));
  const tail = flattened.slice(address.length);
  return canonicalizeMarkers(
    DASH_JOINED_NUMBER_TAIL.test(tail) ? trimCitationTail(flattened) : address,
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
