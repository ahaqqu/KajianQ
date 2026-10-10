import { requireCitationGrammar } from "./citation-grammar";
import type {
  ChunkRefLike,
  CitationFrameLike,
  CitationGrammar,
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
 * The NON-TEXT evidence labels for one answer, from the strongest available
 * source down — the single precedence walk both citation readers share:
 *
 *   1. **The citations frame** (ADR-0040). When the SSE `citations` frame (or
 *      the trace-derived frame) is reachable the caller passes it, and its
 *      labels are the answer. The frame is a server-derived intersection of
 *      the answer's inline citation spans and the chunks the persisted trace
 *      retrieves, so a label in it is grounded **by definition** — the
 *      invariant this scorer relies on: a label the frame does not contain is
 *      never scored present. A fabricated citation cannot reach the frame, so
 *      this direction cannot manufacture a pass. An EMPTY frame is
 *      authoritative and grounds nothing; the trace labels are never consulted
 *      past it.
 *   2. **The trace's `grounded` list** (contracts `review` event, B4). The
 *      deterministic gate's grounded labels, recorded on the trace — the same
 *      provenance as (1) for every persisted trace that predates the frame.
 *      An EMPTY list is meaningful: a refusal records none, and scoring its
 *      required citations as absent is correct. Only an ABSENT list (older
 *      traces) yields `undefined`.
 *
 * `undefined` therefore means there is no non-text evidence at all (no frame,
 * no `grounded` field), and the caller decides its own fallback — only
 * {@link citationLabelsPresent} has one (the answer text); a trap's
 * {@link groundedAnswer} deliberately does not.
 *
 * Deliberately takes NO answer text, and must never take one: the text alone
 * is not evidence (a fabricated citation is citation-shaped too), so an
 * invented label cannot ground its own answer. Keeping the walk text-free
 * makes that invariant structural instead of a property of the tests, and
 * keeps a precedence change from being applied to one reader and forgotten in
 * the other.
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
 * The citation labels the harness can treat as present for one answer. The
 * non-text precedence — the citations frame first, else the trace's `grounded`
 * list — is owned by {@link verifiedEvidenceLabels}; this function adds the
 * final fallback:
 *
 *   3. **The answer text**, through the injected citation grammar. This is the
 *      fallback for local/unit scoring with no frame and no trace. The grammar
 *      is the gate's own (`citationCandidatesIn` + `normalizeCitationLabel`),
 *      so a required label matches equivalent spellings the raw-substring
 *      check missed — `**QS. 1:2**`, `Q.S. 1:2`, `QS 1:2` — rather than only
 *      the byte-identical form. With no grammar injected the check degrades to
 *      the original `String.includes`, so unit behavior is unchanged. A PURE
 * refusal's frame list is empty with its `grounded` list; a HYBRID refusal (#436)
 * carries the grounded labels its text quotes — the list is read, never the flag.
 */
export function citationLabelsPresent(input: {
  required: readonly string[];
  answerText: string;
  frame?: CitationFrameLike | null;
  events?: readonly TraceEventLike[];
  grammar?: CitationGrammar;
}): string[] {
  const { required, answerText, frame, events, grammar } = input;
  // The engine's grammar entry: an unwired grammar fails loudly (R1).
  if (grammar !== undefined) requireCitationGrammar(grammar);
  const evidence = verifiedEvidenceLabels({ frame, events });
  if (evidence !== undefined) return groundedLabels(required, evidence, grammar);
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
 * Whether one answer is grounded by the citation evidence already on hand —
 * the non-refusal branch of a trap question's acceptance (#250, "refuse, or
 * ground it"; ADR-0046). True exactly when {@link verifiedEvidenceLabels}
 * returns at least one label: a non-empty citations frame, else a non-empty
 * trace `grounded` list.
 *
 * There is deliberately **no answer-text fallback**. The text alone is not
 * evidence — a fabricated citation is still citation-shaped — so a text path
 * would let an invented label ground its own answer into a pass, the one
 * direction this check must never allow. A trace with no frame and no
 * `grounded` field (an older trace) therefore scores ungrounded, which leaves
 * the refusal branch to carry the question: the pre-#250 behavior. The shared
 * helper cannot even receive the answer text, so that property cannot be
 * reintroduced by drift.
 */
export function groundedAnswer(input: {
  frame?: CitationFrameLike | null | undefined;
  events?: readonly TraceEventLike[];
}): boolean {
  return (verifiedEvidenceLabels(input) ?? []).length > 0;
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
 *
 * **Both sides are compared as the sets of addresses they name, not as
 * strings** (review A1 of the #274 fix round): a question requires
 * `QS. 2:255`, the answer may cite the range `QS. 2:255-256` the gate grounds,
 * and comparing the two labels as strings scored 0 on the frame path while the
 * trace path scored 1. The relation is the gate's own (strict-whole), read from
 * the injected grammar's required declaration (`citation-grammar.ts`), so the
 * engine re-derives nothing and a grammar declaring `(label) => [label]`
 * behaves exactly as labels-as-strings did.
 *
 * A `null` declaration (review T1) refuses on either side, as the gate does.
 */
function groundedLabels(
  required: readonly string[],
  evidence: readonly string[],
  grammar?: CitationGrammar,
): string[] {
  if (grammar === undefined) {
    return required.filter((citation) => evidence.some((label) => label.includes(citation)));
  }
  const named = new Set(
    evidence.flatMap((label) => namedAddressesOf(label, grammar) ?? []).map(grammar.normalizeLabel),
  );
  return required.filter((citation) => {
    const addresses = namedAddressesOf(citation, grammar);
    return addresses !== null && addresses.every((a) => named.has(grammar.normalizeLabel(a)));
  });
}

/** The addresses one label names; `null` (review T1) is a refusal, and `[]`
 * falls back to the label so a label the grammar cannot parse matches whole. */
const namedAddressesOf = (label: string, grammar: CitationGrammar): readonly string[] | null => {
  const declared = grammar.addressesNamedBy(label);
  return declared === null ? null : declared.length > 0 ? declared : [label];
};

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
  // Guarded before the empty-required short-circuit, so an unwired grammar
  // fails even on a question whose citations are trivially satisfied (R1).
  if (evidence?.grammar !== undefined) requireCitationGrammar(evidence.grammar);
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
 * The acceptance rule for one question's expected behavior (#250, ADR-0046).
 *
 * An `answer` question is accepted exactly as before — the refusal comparison
 * is untouched, so over-refusal (stonewalling an answerable question) still
 * fails deterministically. A `refuse` question (a trap) is accepted when the
 * pipeline refused **or** when the answer is grounded ({@link groundedAnswer}).
 * The product has two acceptable renderings of the same good behavior — the
 * canonical refusal, and a decline that grounds itself in scripture in its own
 * words — and coupling the gate to the first one's exact prose made the
 * question flap on the model's phrasing. There is no third input: no
 * per-question vocabulary, no acceptance block, no date detector.
 *
 * The grounded branch is what keeps a trap live. `gs-v0-019` carries
 * `requiredCitations: []` and `expectedSourceTypes: []`, so citation validity
 * and retrieval recall are satisfied trivially and this dimension is its only
 * live check: a non-refusal that carries no verified citation fails, so a trap
 * cannot be passed by simply answering. (See `groundedAnswer` for why the
 * answer text cannot ground itself.)
 *
 * RESIDUAL, ACCEPTED (#250, ADR-0046): a grounded-but-DATED answer therefore
 * passes — "no one knows, though it is expected around 2077", citing a real
 * verse. The prohibition on asserting a demanded-but-absent date is
 * **prompt-enforced only** (the generator's strict rule 1; SPECS §3.3):
 * nothing machine-checks it, at runtime or at grading time. This is a recorded
 * trade, not an oversight — the machine date detector was built and rejected
 * (#248) as a per-question detector that does not generalize to the next trap.
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

/** The retrieval events of one trace, in order. */
export function retrievalEventsOf(trace: { events: RetrievalLike[] }): RetrievalLike[] {
  return trace.events.filter((e) => e.kind === "retrieval");
}
