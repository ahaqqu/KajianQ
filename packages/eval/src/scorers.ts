import type { GroundedDeclineAcceptance } from "@app/contracts";
import type {
  ChunkRefLike,
  CitationFrameLike,
  CitationGrammar,
  DateAssertionDetector,
  RetrievalLike,
  TraceEventLike,
} from "./harness-types";

/**
 * Deterministic scorers (#8, spec §3.7): retrieval recall, citation validity,
 * and refusal correctness. No LLM involvement — the metrics the spec marks
 * "deterministic" come from persisted traces and the answer text alone.
 */

/**
 * Retrieval recall: the fraction of the question's expected source types that
 * appear among the retrieval event's retrieved chunks (by chunk metadata's
 * `sourceType` value, read from the trace's chunk refs' stored metadata when
 * the caller can join it, or from the ref ids when the caller pre-joins).
 *
 * The harness passes the retrieval event plus a resolver that maps a chunk
 * id to its source-type label; the trace itself carries only ids (ADR-0007),
 * so the join is the caller's knowledge, not a re-parse.
 */
export function retrievalRecall(
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
 * The citation labels the harness can treat as present for one answer, from
 * the strongest available evidence source down. The precedence is deliberate:
 *
 *   1. **The citations frame** (ADR-0040). When the SSE `citations` frame (or
 *      the trace-derived frame) is reachable the caller passes it, and its
 *      labels are the answer. The frame is a server-derived intersection of
 *      the answer's inline citation spans and the chunks the persisted trace
 *      retrieves, so a label in it is grounded **by definition** — the
 *      invariant this scorer relies on: a label the frame does not contain is
 *      never scored present. A fabricated citation cannot reach the frame, so
 *      this direction cannot manufacture a pass.
 *   2. **The trace's `grounded` list** (contracts `review` event, B4). The
 *      deterministic gate's grounded labels, recorded on the trace — the same
 *      provenance as (1) for every persisted trace that predates the frame.
 *      An EMPTY list is meaningful: a refusal records none, and scoring its
 *      required citations as absent is correct. Only an ABSENT list (older
 *      traces) falls through to (3).
 *   3. **The answer text**, through the injected citation grammar. This is the
 *      fallback for local/unit scoring with no frame and no trace. The grammar
 *      is the gate's own (`citationCandidatesIn` + `normalizeCitationLabel`),
 *      so a required label matches equivalent spellings the raw-substring
 *      check missed — `**QS. 1:2**`, `Q.S. 1:2`, `QS 1:2` — rather than only
 *      the byte-identical form. With no grammar injected the check degrades to
 *      the original `String.includes`, so unit behavior is unchanged.
 *
 * A refusal needs no special case: its frame carries `refusal: true` with an
 * empty citation list and its trace's `grounded` list is empty, so its
 * required citations are absent by construction on every path.
 */
export function citationLabelsPresent(input: {
  required: readonly string[];
  answerText: string;
  frame?: CitationFrameLike | null;
  events?: readonly TraceEventLike[];
  grammar?: CitationGrammar;
}): string[] {
  const { required, answerText, frame, events, grammar } = input;
  if (frame != null) {
    return groundedLabels(
      required,
      frame.citations.map((citation) => citation.label),
      grammar,
    );
  }
  const grounded = events === undefined ? undefined : reviewerGroundedLabels(events);
  if (grounded !== undefined) {
    return groundedLabels(required, grounded, grammar);
  }
  return groundedLabels(required, textCandidateLabels(answerText, grammar), grammar);
}

/**
 * The `grounded` list of the trace's `review` event, or `undefined` when the
 * trace carries no such event or an older one without the field — the signal
 * to fall back to the text. An empty array is a real value (the gate grounded
 * nothing), never treated as "absent".
 */
function reviewerGroundedLabels(events: readonly TraceEventLike[]): string[] | undefined {
  const review = events.filter((event) => event.kind === "review").at(-1);
  const grounded = review?.detail?.grounded;
  return Array.isArray(grounded) ? grounded : undefined;
}

/**
 * The citation-shaped spans of the answer text, normalized by the injected
 * grammar. With no grammar the whole text is the only candidate, so the
 * downstream `includes` comparison reduces to the original substring check.
 */
function textCandidateLabels(answerText: string, grammar?: CitationGrammar): string[] {
  return grammar === undefined ? [answerText] : grammar.labelsInText(answerText);
}

/**
 * Which required citations the evidence contains. Matching is normalized when
 * a grammar is injected, so the fixture's curated spelling (`QS. 1:2`) matches
 * an evidence label in any equivalent form the grammar canonicalizes. Without
 * a grammar the comparison stays the byte-exact substring test it always was.
 */
function groundedLabels(
  required: readonly string[],
  evidence: readonly string[],
  grammar?: CitationGrammar,
): string[] {
  if (grammar === undefined) {
    return required.filter((citation) => evidence.some((label) => label.includes(citation)));
  }
  const known = new Set(evidence.map(grammar.normalizeLabel));
  return required.filter((citation) => known.has(grammar.normalizeLabel(citation)));
}

/**
 * Citation validity: the fraction of the question's required citations the
 * answer's evidence contains. Preference order (see {@link citationLabelsPresent}):
 * the citations frame when the caller has one, then the trace's `grounded`
 * list, then the answer text through the gate's grammar. A question with no
 * required citations scores 1 (nothing to violate).
 *
 * The text path keeps the original two-argument semantics when no grammar is
 * injected, so existing unit callers are unaffected.
 */
export function citationValidity(
  requiredCitations: readonly string[],
  answerText: string,
  evidence?: {
    frame?: CitationFrameLike | null | undefined;
    events?: readonly TraceEventLike[];
    grammar?: CitationGrammar;
  },
): number {
  if (requiredCitations.length === 0) return 1;
  const present = citationLabelsPresent({
    required: requiredCitations,
    answerText,
    ...(evidence?.frame !== undefined ? { frame: evidence.frame } : {}),
    ...(evidence?.events !== undefined ? { events: evidence.events } : {}),
    ...(evidence?.grammar !== undefined ? { grammar: evidence.grammar } : {}),
  }).length;
  return present / requiredCitations.length;
}

/**
 * Refusal correctness: did the pipeline's observable behavior match the
 * question's expectation? A refusal is detected from the trace's `refusal`
 * event or a refusal-marker in the text (exact markers come from the caller —
 * the engine stays language-agnostic).
 */
export function refusalCorrectness(
  expectedBehavior: "answer" | "refuse",
  refused: boolean,
): boolean {
  return expectedBehavior === "refuse" ? refused : !refused;
}

/**
 * Refusal detection over one run's trace events: true when any stage recorded
 * a `refusal` event, or when the answer text matches one of the caller's
 * refusal markers.
 */
export function detectRefusal(
  events: readonly TraceEventLike[],
  answerText: string,
  refusalMarkers: readonly string[],
): boolean {
  if (events.some((e) => e.kind === "refusal")) return true;
  return refusalMarkers.some((m) => m !== "" && answerText.includes(m));
}

/**
 * The grounded-decline acceptance (#244, owner decision 2026-09-27). A
 * `refuse` question may carry this optional block when the pipeline has TWO
 * acceptable renderings at its boundary; this scorer then accepts the second
 * one, the grounded decline, without a `refusal` event or refusal marker.
 *
 * The rule is deliberately a conjunction of three checks, all deterministic —
 * no LLM judge, because the point is to remove run-to-run variation, and a
 * nondeterministic acceptance would reintroduce it one layer up:
 *
 *   1. **Decline proof** — the answer contains one configured marker
 *      (case-insensitive). A vague or hedging answer is not a decline.
 *   2. **No date assertion** — the injected domain detector
 *      (`DateAssertionDetector`, `assertsCalendarDate`) finds no calendar
 *      date. This is the requirement the trap exists to enforce ("do not
 *      assert a date for the Hour"): a dated answer fails no matter how well
 *      it is cited. The detector is literal-patterned domain code, so the
 *      engine names no vocabulary and compiles no regex; the strict direction
 *      (reject on any date-ish token) never swallows a date.
 *   3. **Grounded citations** — every citation-shaped span the answer carries
 *      is present in the answer's `citations` frame (ADR-0040) or the trace
 *      reviewer `grounded` labels. A fabricated citation reaches neither, so
 *      it fails. An answer with no citation spans is vacuously grounded —
 *      deliberately (thermos A4): the bare-refusal rendering already passed
 *      this question with zero citation spans, because `gs-v0-019`'s
 *      `requiredCitations` is empty and `citationValidity` returns 1 without
 *      inspecting the text (`citationValidity`, above — executed: a refusal
 *      event plus a fabricated span still passes the legacy path). So the
 *      uncited decline loosens nothing beyond the acceptance that already
 *      existed, and it is the stricter of the two renderings: it rejects a
 *      fabricated span the refusal path never looks at.
 *
 * Fail-closed by construction: without the injected date detector, the
 * citation grammar, or grounding evidence, the acceptance returns false
 * rather than admitting an uncheckable answer. The real CLI injects the
 * detector and grammar and the transport carries the frame, so the accepted
 * path is the production path; a unit caller that omits them simply gets no
 * extra acceptance.
 */
export function groundedDeclineAccepts(input: {
  answerText: string;
  acceptance: GroundedDeclineAcceptance;
  frame?: CitationFrameLike | null | undefined;
  events?: readonly TraceEventLike[] | undefined;
  grammar?: CitationGrammar | undefined;
  assertsDate?: DateAssertionDetector | undefined;
}): boolean {
  const { answerText, acceptance, frame, events, grammar, assertsDate } = input;

  // 1. The answer must say it declines (any-of, case-insensitive).
  const haystack = answerText.toLowerCase();
  if (!acceptance.markers.some((marker) => haystack.includes(marker.toLowerCase()))) return false;

  // 2. No date assertion — a domain-owned, literal-patterned check. No
  //    detector injected ⇒ fail closed.
  if (assertsDate === undefined || assertsDate(answerText)) return false;

  // 3. Every citation-shaped span must be grounded — and the grounding must be
  //    verifiable. No grammar or no evidence ⇒ fail closed.
  if (grammar === undefined) return false;
  const spans = grammar.labelsInText(answerText);
  const evidence = groundedEvidenceLabels(frame, events);
  if (evidence === undefined) return false;
  const grounded = new Set(evidence.map(grammar.normalizeLabel));
  return spans.every((span) => grounded.has(grammar.normalizeLabel(span)));
}

/**
 * The grounded label evidence for an answer, in the same precedence
 * `citationLabelsPresent` uses: the server-derived frame first (a label in it
 * is grounded by construction, ADR-0040), then the trace reviewer `grounded`
 * list. `undefined` means neither is available — the caller must fail closed
 * rather than treat the answer text as its own evidence.
 */
function groundedEvidenceLabels(
  frame: CitationFrameLike | null | undefined,
  events: readonly TraceEventLike[] | undefined,
): string[] | undefined {
  if (frame != null) return frame.citations.map((citation) => citation.label);
  return reviewerGroundedLabels(events ?? []);
}

/** The retrieval events of one trace, in order. */
export function retrievalEventsOf(trace: { events: RetrievalLike[] }): RetrievalLike[] {
  return trace.events.filter((e) => e.kind === "retrieval");
}
