/** The per-question scorer: the harness owns the run lifecycle, this module owns one
 * question's verdict. */
import type { EvalResultOutcome, GoldenQuestion } from "@app/contracts";
import type { HarnessDeps } from "./harness";
import { expansionProvenance, quoteFidelityOutcome } from "./harness-outcomes";
import type { ChunkRefLike, CitationFrameLike, TraceEventLike } from "./harness-types";
import {
  behaviorAccepted,
  citationAddressRecall,
  citationValidity,
  detectRefusal,
  groundedAnswer,
  identitySatisfiedCitationAddressRecall,
  sourceTypeRecall,
} from "./scorers";

/** Score one question from its answer text, trace events, and the citations frame
 * when the transport carried one. A question passes only when behaviour, both
 * recall dimensions and citation validity are all complete — the address dimension
 * excepted when the run gates only on the others (`gateAddressRecall: false`). The
 * trap rule's residual lives in `behaviorAccepted`.
 *
 * The `identitySatisfied` block is REPORTED, never gating: it repeats the address
 * and validity readings through the broader signed relation and derives the
 * counterfactual verdict, so an exact-address residual is visible as a number
 * without redefining `passed`. It is written only when the caller injected an
 * identity resolver; a run without one keeps its historical outcome shape. */
export function scoreQuestion(
  question: GoldenQuestion,
  answerText: string,
  events: readonly TraceEventLike[],
  deps: Pick<
    HarnessDeps,
    | "sourceTypeOf"
    | "citationOf"
    | "refusalMarkers"
    | "citationGrammar"
    | "citationIdentity"
    | "reportedCitationIdentity"
    | "expansionOrigin"
    | "gateAddressRecall"
    | "lookupOrigin"
    | "quoteEquivalences"
  >,
  frame?: CitationFrameLike | null,
): EvalResultOutcome {
  const retrieval = events.filter((e) => e.kind === "retrieval").at(-1);
  const chunks = retrieval?.detail?.chunks ?? [];
  const alternatives = question.citationAlternatives ?? [];
  const sourceTypes = sourceTypeRecall(question.expectedSourceTypes, chunks, deps.sourceTypeOf);
  const addressRecall = citationAddressRecall(
    question.requiredCitations,
    chunks,
    deps.citationOf,
    deps.citationGrammar,
    alternatives,
  );
  const citations = citationValidity(question.requiredCitations, answerText, {
    frame,
    events,
    ...(deps.citationGrammar !== undefined ? { grammar: deps.citationGrammar } : {}),
    ...(deps.citationIdentity !== undefined ? { identity: deps.citationIdentity } : {}),
    ...(alternatives.length > 0 ? { alternatives } : {}),
  });
  const refused = detectRefusal(events, answerText, deps.refusalMarkers ?? []);
  const grounded = groundedAnswer({ frame, events });
  const correct = behaviorAccepted(question.expectedBehavior, refused, grounded);
  const passed =
    correct &&
    citations === 1 &&
    sourceTypes === 1 &&
    (deps.gateAddressRecall === false || addressRecall === 1);
  const identitySatisfied = reportedIdentityOutcome({
    question,
    answerText,
    events,
    chunks,
    frame,
    deps,
    correct,
    sourceTypes,
    alternatives,
  });
  return {
    questionId: question.id,
    expectedBehavior: question.expectedBehavior,
    passed,
    sourceTypeRecall: sourceTypes,
    citationAddressRecall: addressRecall,
    citationValidity: citations,
    ...quoteFidelityOutcome(answerText, frame, deps.quoteEquivalences),
    refused,
    ...(identitySatisfied !== undefined ? { identitySatisfied } : {}),
    ...expansionProvenance({
      expectedSourceTypes: question.expectedSourceTypes,
      chunks,
      events,
      sourceTypeOf: deps.sourceTypeOf,
      ...(deps.expansionOrigin !== undefined ? { expansionOrigin: deps.expansionOrigin } : {}),
      ...(deps.lookupOrigin !== undefined ? { lookupOrigin: deps.lookupOrigin } : {}),
    }),
  };
}

/**
 * The reported identity-satisfied block: the address and validity readings through
 * the broader resolver, then the counterfactual verdict. Same gate composition as
 * `passed` — including the run's address-gating policy — so the two verdicts are
 * like-for-like and the difference is only which relation the citation dimensions
 * read. `undefined` when no identity was injected, because the block would then be
 * a copy of the exact numbers under a name that claims more.
 */
function reportedIdentityOutcome(input: {
  question: GoldenQuestion;
  answerText: string;
  events: readonly TraceEventLike[];
  chunks: readonly ChunkRefLike[];
  frame?: CitationFrameLike | null | undefined;
  deps: Pick<
    HarnessDeps,
    | "citationOf"
    | "citationGrammar"
    | "citationIdentity"
    | "reportedCitationIdentity"
    | "gateAddressRecall"
  >;
  correct: boolean;
  sourceTypes: number;
  alternatives: readonly string[];
}): EvalResultOutcome["identitySatisfied"] {
  const { question, deps } = input;
  const identity = deps.reportedCitationIdentity ?? deps.citationIdentity;
  if (identity === undefined) return undefined;
  const citationAddressRecallValue = identitySatisfiedCitationAddressRecall({
    requiredCitations: question.requiredCitations,
    retrieved: input.chunks,
    citationOf: deps.citationOf,
    identity,
    ...(deps.citationGrammar !== undefined ? { grammar: deps.citationGrammar } : {}),
    ...(input.alternatives.length > 0 ? { alternatives: input.alternatives } : {}),
  });
  const citationValidityValue = citationValidity(question.requiredCitations, input.answerText, {
    frame: input.frame,
    events: input.events,
    ...(deps.citationGrammar !== undefined ? { grammar: deps.citationGrammar } : {}),
    identity,
    ...(input.alternatives.length > 0 ? { alternatives: input.alternatives } : {}),
  });
  return {
    citationAddressRecall: citationAddressRecallValue,
    citationValidity: citationValidityValue,
    passed:
      input.correct &&
      citationValidityValue === 1 &&
      input.sourceTypes === 1 &&
      (deps.gateAddressRecall === false || citationAddressRecallValue === 1),
  };
}
