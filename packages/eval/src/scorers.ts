import { requireCitationGrammar } from "./citation-grammar";
import type {
  ChunkRefLike,
  CitationFrameLike,
  CitationGrammar,
  CitationIdentity,
  RetrievalLike,
  TraceEventLike,
} from "./harness-types";
import { requireCitationIdentity, resolveIdentity } from "./citation-identity";
import { comparedAddressesOf } from "./scorers-address";

export { citationAddressRecall, identitySatisfiedCitationAddressRecall } from "./scorers-address";

/** Deterministic scorers — source-type recall, citation-address recall,
 * citation validity, refusal correctness — with no LLM involvement: the metrics
 * come from persisted traces and the answer text alone. */

/** Source-type recall: the fraction of the question's expected source types
 * found among the retrieval event's retrieved chunks; the trace carries only
 * chunk ids, so the caller supplies `sourceTypeOf` to resolve them. This asks
 * whether retrieval reached the right **kind** of source; it says nothing about
 * whether the required address was among the chunks (see
 * {@link citationAddressRecall}). */
export function sourceTypeRecall(
  expectedSourceTypes: readonly string[],
  retrieved: readonly ChunkRefLike[],
  sourceTypeOf: (chunkId: string) => string | undefined,
): number {
  if (expectedSourceTypes.length === 0) return 1;
  const hit = new Set(
    expectedSourceTypes.filter((t) => retrieved.some((c) => sourceTypeOf(c.id) === t)),
  );
  return hit.size / expectedSourceTypes.length;
}

/**
 * The NON-TEXT evidence labels for one answer, from the strongest available
 * source down — the precedence walk both citation readers share: the citations
 * frame first, else the trace's `grounded` list. The frame is the server-derived
 * intersection of the answer's citation spans with the persisted trace's
 * retrieved chunks, so a label in it is grounded by definition — a label the
 * frame lacks is never scored present, and an EMPTY frame is authoritative.
 * An EMPTY `grounded` list is likewise meaningful; only an ABSENT list yields
 * `undefined`, meaning no non-text evidence, and the caller picks its fallback.
 * Deliberately takes NO answer text: the text alone is not evidence.
 */
function verifiedEvidenceLabels(input: {
  frame?: CitationFrameLike | null | undefined;
  events?: readonly TraceEventLike[] | undefined;
}): string[] | undefined {
  const { frame, events } = input;
  if (frame != null) return frame.citations.map((citation) => citation.label);
  return events === undefined ? undefined : reviewerGroundedLabels(events);
}

/**
 * The citation labels the harness can treat as present for one answer:
 * {@link verifiedEvidenceLabels} first, then the answer text through the
 * injected citation grammar, which is the gate's own — so equivalent marker
 * spellings match, not only the byte-identical form. With no grammar the check
 * degrades to a substring test.
 */
export function citationLabelsPresent(input: {
  required: readonly string[];
  answerText: string;
  frame?: CitationFrameLike | null;
  events?: readonly TraceEventLike[];
  grammar?: CitationGrammar;
  identity?: CitationIdentity;
  alternatives?: readonly string[];
}): string[] {
  const { required, answerText, frame, events, grammar, identity, alternatives = [] } = input;
  // An unwired grammar fails loudly at the engine's grammar entry.
  if (grammar !== undefined) requireCitationGrammar(grammar);
  if (identity !== undefined) requireCitationIdentity(identity);
  const evidence = verifiedEvidenceLabels({ frame, events });
  if (evidence !== undefined) {
    return groundedLabels(required, evidence, grammar, identity, alternatives);
  }
  return groundedLabels(
    required,
    textCandidateLabels(answerText, grammar),
    grammar,
    identity,
    alternatives,
  );
}

/** The `grounded` list of the trace's `review` event, or `undefined` when the
 * trace carries no such event or one without the field — the signal to fall
 * back to the text. An empty array is a real value, never "absent". */
function reviewerGroundedLabels(events: readonly TraceEventLike[]): string[] | undefined {
  const review = events.filter((event) => event.kind === "review").at(-1);
  const grounded = review?.detail?.grounded;
  return Array.isArray(grounded) ? grounded : undefined;
}

/**
 * Whether one answer is grounded by the citation evidence already on hand — the
 * non-refusal branch of a trap question's acceptance. True exactly when
 * {@link verifiedEvidenceLabels} returns at least one label.
 *
 * There is deliberately **no answer-text fallback**: a text path would let an
 * invented label ground its own answer into a pass.
 */
export function groundedAnswer(input: {
  frame?: CitationFrameLike | null | undefined;
  events?: readonly TraceEventLike[];
}): boolean {
  return (verifiedEvidenceLabels(input) ?? []).length > 0;
}

/** The citation-shaped spans of the answer text, normalized by the injected
 * grammar; with no grammar the whole text is the only candidate, reducing the
 * comparison to a substring check. */
function textCandidateLabels(answerText: string, grammar?: CitationGrammar): string[] {
  return grammar === undefined ? [answerText] : grammar.labelsInText(answerText);
}

/**
 * Which required citations the evidence contains. Both sides are compared as
 * the **sets of addresses they name**, not as strings — a question may require
 * `QS. 2:255` while the answer cites the grounded range `QS. 2:255-256` — using
 * the gate's own relation from the injected grammar, so the engine re-derives
 * nothing. A `null` declaration refuses on either side; without a grammar the
 * comparison stays the byte-exact substring test.
 *
 * A citation that is not the same row but is the same **narration** matches
 * through the injected {@link CitationIdentity}: the identity is consulted only
 * after the address comparison misses, and only when the required label
 * resolves; a label the map does not carry resolves to `null` and matches
 * nothing. That keeps the exact-row path and the fail-closed behavior for
 * unmapped, fabricated, and unrelated citations.
 *
 * `alternatives` is a curator's opt-in any-of set for a single-requirement row:
 * a requirement is satisfied when any member of the set matches, exactly as the
 * requirement itself would. The members are different reports, so the set is a
 * requirement decision rather than an identity — a same-ruling identity never
 * reaches this path under the gate's resolver.
 */
function groundedLabels(
  required: readonly string[],
  evidence: readonly string[],
  grammar?: CitationGrammar,
  identity?: CitationIdentity,
  alternatives: readonly string[] = [],
): string[] {
  const matches = (citation: string): boolean => {
    if (grammar === undefined) {
      return (
        evidence.some((label) => label.includes(citation)) ||
        sameIdentity(identity, citation, evidence)
      );
    }
    const named = new Set(evidence.flatMap((label) => comparedAddressesOf(label, grammar) ?? []));
    const addresses = comparedAddressesOf(citation, grammar);
    if (addresses !== null && addresses.every((address) => named.has(address))) return true;
    return sameIdentity(identity, citation, evidence);
  };
  return required.filter((citation) => [citation, ...alternatives].some(matches));
}

/** Whether one required citation names the same curated identity as any
 * evidence label. `null` on either side means the map carries no identity, and
 * the answer is no — never a guess. */
function sameIdentity(
  identity: CitationIdentity | undefined,
  citation: string,
  evidence: readonly string[],
): boolean {
  if (identity === undefined) return false;
  const requiredIdentity = resolveIdentity(identity, citation);
  if (requiredIdentity === null) return false;
  return evidence.some((label) => resolveIdentity(identity, label) === requiredIdentity);
}

/**
 * Citation validity: the fraction of the question's required citations the
 * answer's evidence contains, in the preference order
 * {@link citationLabelsPresent} owns. No required citations scores 1; without a
 * grammar the text path keeps its two-argument semantics. An injected
 * {@link CitationIdentity} lets a required citation be satisfied by a parallel
 * narration of it, never by a different one. `alternatives` is the row's opt-in
 * any-of set (see {@link groundedLabels}); absent, the all-required default is
 * unchanged.
 */
export function citationValidity(
  requiredCitations: readonly string[],
  answerText: string,
  evidence?: {
    frame?: CitationFrameLike | null | undefined;
    events?: readonly TraceEventLike[];
    grammar?: CitationGrammar;
    identity?: CitationIdentity;
    alternatives?: readonly string[];
  },
): number {
  // Guarded before the empty-required early return, so an unwired grammar or a
  // malformed identity resolver fails even on a question whose citations are
  // trivially satisfied.
  if (evidence?.grammar !== undefined) requireCitationGrammar(evidence.grammar);
  if (evidence?.identity !== undefined) requireCitationIdentity(evidence.identity);
  if (requiredCitations.length === 0) return 1;
  const present = citationLabelsPresent({
    required: requiredCitations,
    answerText,
    ...(evidence?.frame !== undefined ? { frame: evidence.frame } : {}),
    ...(evidence?.events !== undefined ? { events: evidence.events } : {}),
    ...(evidence?.grammar !== undefined ? { grammar: evidence.grammar } : {}),
    ...(evidence?.identity !== undefined ? { identity: evidence.identity } : {}),
    ...(evidence?.alternatives !== undefined ? { alternatives: evidence.alternatives } : {}),
  }).length;
  return present / requiredCitations.length;
}

/** Whether the observable behavior matched the question's expectation. */
export function refusalCorrectness(
  expectedBehavior: "answer" | "refuse",
  refused: boolean,
): boolean {
  return expectedBehavior === "refuse" ? refused : !refused;
}

/**
 * The acceptance rule for one question's expected behavior. An `answer` question
 * is accepted exactly when the refusal comparison passes, so over-refusal of an
 * answerable question still fails deterministically. A `refuse` question (a
 * trap) is accepted when the pipeline refused **or** when the answer is grounded
 * ({@link groundedAnswer}): the product has two acceptable renderings of the
 * same good behavior, and coupling the gate to the canonical refusal's exact
 * prose makes a question flap on the model's phrasing.
 *
 * The grounded branch is what keeps a trap live — a question with no required
 * citations and no expected source types is trivially citation-valid and
 * recall-complete, so a non-refusal carrying no verified citation fails.
 * RESIDUAL, ACCEPTED: a grounded-but-DATED answer therefore passes, because the
 * date prohibition is prompt-enforced only.
 */
export function behaviorAccepted(
  expectedBehavior: "answer" | "refuse",
  refused: boolean,
  grounded: boolean,
): boolean {
  return (
    refusalCorrectness(expectedBehavior, refused) || (expectedBehavior === "refuse" && grounded)
  );
}

/** Refusal detection over one run's trace events: true when any stage recorded
 * a `refusal` event, or the answer text matches one of the caller's refusal
 * markers. */
export function detectRefusal(
  events: readonly TraceEventLike[],
  answerText: string,
  refusalMarkers: readonly string[],
): boolean {
  if (events.some((e) => e.kind === "refusal")) return true;
  return refusalMarkers.some((m) => m !== "" && answerText.includes(m));
}

/** The retrieval events of one trace, in order. */
export function retrievalEventsOf(trace: { events: RetrievalLike[] }): RetrievalLike[] {
  return trace.events.filter((e) => e.kind === "retrieval");
}
