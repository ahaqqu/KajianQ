import type { Chunk } from "@app/rag-core";
import { addressesNamedBy, declaresAddressList } from "./chat-citation-grammar";
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
// `addressesNamedBy` joins them because it IS the comparison form's other half:
// the addresses a citation names are what the per-address rule compares, and
// the eval's injected grammar reads the same declaration rather than a second
// implementation of the range's semantics.
export { addressesNamedBy, citationCandidatesIn, citationSpansIn, normalizeCitationLabel };

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
 * **Which retrieved labels ground one citation-shaped span** — the single
 * implementation of the gate's rule, returned rather than decided so every
 * consumer of "grounded" reads the same answer (review A1 of the fix round).
 *
 * The gate's ungrounded direction and the user-visible citations frame
 * (`deriveCitationsFrame`) both call this. Before it existed they each carried
 * their own reading, so a range the gate had just accepted still produced no
 * chip for the user and scored `citationValidity` 0 on the eval's authoritative
 * frame path. A third consumer cannot be written by accident now: the rule has
 * one owner, and its result is the accepted label(s) rather than a boolean —
 * the frame needs the label to find the display row, and the eval's frame path
 * matches on exactly those labels.
 *
 * `candidate` is a normalized span (the grammar scan's output); `known` is the
 * retrieved chunks' normalized citation labels. All three rules run in the
 * gate's order:
 *
 * 1. the span **is** a retrieved label (the ordinary case);
 * 2. the span **names addresses of its own** — a grammar that declares a list,
 *    the Quran range, of any width (#444) — and every one of them is
 *    retrieved — strict-whole, the interior included (ADR-0049);
 * 3. the span **extends** a retrieved label with a grade the chunk did not
 *    carry (`HR. Bukhari no. 573 (Sahih)`), which is the answer's provenance,
 *    not a second address.
 *
 * **A declared list of ONE is a list too (#444), and the branch reads the
 * declaration itself (#449).** Rule 2 decides a declared list of any width: a
 * range whose endpoints are equal (`QS. 1:1–1`) names exactly the address its
 * two endpoints spell, so it grounds exactly when that address is retrieved.
 * The rule used to be gated on `named.length > 1`, reading "one declared address"
 * as the ordinary case rule 1 already covers — true for a plain `QS. 1:1`, false
 * for a one-address *range*, which declares a list the length test could not see
 * at all. Such a span skipped rule 2, reached rule 3, found no `<label>` + space
 * (a range continues with a dash, never a space) and was refused although its own
 * address was retrieved: on staging that refusal replaced a 31-chunk grounded
 * answer with the canonical one (trace `b8812e2d-…`, merge `d30c40cf`).
 *
 * That branch is taken **exactly when the grammar declares an address list**
 * (`declaresAddressList`), read from the grammar's own structure rather than
 * inferred from the shape of what the declaration named. The proxy it replaced and
 * the class that proxy let past rule 2 into rule 3 are stated once, on
 * `declaresAddressList` — the one owner of that mechanism — so this site points
 * there rather than keeping a copy that can drift from it (#449). A plain span's own
 * address is the list of one its grammar declares, so it grounds on that address and
 * on nothing else; a grammar that declares no list has no per-address reading to take
 * and keeps the extension rule whole. A range of one the surah cannot hold
 * (`QS. 2:0-0`, `QS. 2:999–999`) stays unenumerable and refuses above, like any other
 * list that cannot be verified.
 *
 * The list rule runs **before** the extension rule, and a declared list that is
 * not fully retrieved returns `null` rather than falling through: a spaced
 * range (`QS. 2:255 - 256`, review R5 of the fix round) *does* extend the
 * retrieved head with a space, so the old order grounded it on the head alone
 * — the very hole A2 closed for the glued spelling. A grammar that declares no
 * list (the hadith number) keeps the extension rule as its only reading.
 *
 * A declared list the grammar **cannot enumerate** refuses too, and that
 * refusal is read from a distinct state rather than guessed from the list's
 * length (review T1 of the fix round): `addressesNamedBy` returns `null` for
 * it, never a one-element list. Encoded as `[label]` it was indistinguishable
 * from a single-address declaration, so the rule below was skipped and the
 * extension rule grounded `QS. 2:255 - 999` on `QS. 2:255` while its glued
 * twin refused — the spaced spelling weaker than the glued one at exactly the
 * address ADR-0049 names as the refusal case.
 *
 * Like the whole-label rule it replaces, no rule here can ground a citation
 * that rule refused. `null` means nothing retrieved grounds the span; every
 * returned label is in `known` by construction, so a caller can look each one
 * up directly.
 */
export function groundingLabelsFor(
  candidate: string,
  known: ReadonlySet<string>,
): readonly string[] | null {
  if (known.has(candidate)) return [candidate];
  // A declared list the grammar could not enumerate is unverifiable: refuse
  // outright, before the branch below can mistake it for a single address.
  const declared = addressesNamedBy(candidate);
  if (declared === null) return null;
  // ADR-0049: every address the citation's own grammar declares it names must be
  // present — a declared list of ONE exactly like a list of two (#444). The branch
  // is keyed to the grammar's DECLARATION (`declaresAddressList`), read from the
  // grammar's own structure — never to the shape of the addresses it named (#449);
  // the proxy it replaces, and the marker class that proxy let through, are stated
  // once on `declaresAddressList` — the one owner of the fact. No caller can build a
  // set holding the bare marker from a chunk label today (`normalizeCitationLabel`
  // reads `QS.` as `QS`), which is why the hole was latent; the branch no longer
  // rests on that. A grammar that declares no list has no address list to decide
  // address by address: it names the label itself whole and keeps the extension rule
  // below.
  const named = declared.map(canonicalizeCitationSpelling);
  if (declaresAddressList(candidate)) {
    // A declared list that enumerated nothing is unverifiable too: refuse it
    // rather than grounding a citation on an empty set.
    if (named.length === 0) return null;
    return named.every((address) => known.has(address)) ? named : null;
  }
  // The extension rule can match more than one known label (a shortened label
  // and the same label carrying the grade), so all matches come back: this
  // function's set is then equal to the gate's `grounded` list, which adds
  // every label the answer text contains.
  const extended = [...known].filter((label) => candidate.startsWith(`${label} `));
  if (extended.length > 0) return extended;
  return null;
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
 * (ADR-0049), by {@link groundingLabelsFor}.** The Quran range is such a form:
 * `QS. 3:1-2` names `QS. 3:1` *and* `QS. 3:2`, so it grounds exactly when the
 * retrieved labels hold every one of them — and still refuses when only the
 * head, only the tail, or neither was retrieved. `QS. 2:255-260` names 255
 * through 260, interior included. The list comes from the grammar that declared
 * it (`addressesNamedBy`), never from splitting a dash at this site: a grammar
 * with no list-valued form names one address and its dash-joined compound
 * stays the opaque whole it was (#264's A3 boundary, unchanged for hadith).
 * The candidate label itself is untouched, so the refusal reason, the reviewer
 * pre-gate's claim spans and the citation the user reads keep naming what the
 * draft named.
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
  const grounded = new Set<string>();
  for (const label of known) {
    if (normalizedAnswer.includes(label)) grounded.add(label);
  }
  const ungrounded: string[] = [];
  for (const candidate of citationCandidatesIn(answer)) {
    const accepted = groundingLabelsFor(candidate, known);
    if (accepted === null) {
      if (!ungrounded.includes(candidate)) ungrounded.push(candidate);
      continue;
    }
    // A citation that names a list of addresses cites every one of them, so
    // the provenance list names them all — not only the ones the substring
    // pass found literally in the text. `QS. 3:1-2` written over retrieved
    // `QS. 3:1` and `QS. 3:2` says `grounded: ["QS. 3:1", "QS. 3:2"]`, which
    // is what makes the trace's evidence agree with the frame and with the
    // scorer on a range (review A1 of the #274 fix round: the tail address is
    // never a literal substring of `QS. 3:1-2`, so the events path used to
    // score a required tail verse 0 while the frame path scored it 1).
    for (const label of accepted) grounded.add(label);
  }
  return { grounded: [...grounded], ungrounded };
}
