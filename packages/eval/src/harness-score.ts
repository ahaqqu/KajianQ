import type { EvalResultOutcome, GoldenQuestion } from "@app/contracts";
import type { HarnessDeps } from "./harness";
import { expansionProvenance, quoteFidelityOutcome } from "./harness-outcomes";
import type { CitationFrameLike, TraceEventLike } from "./harness-types";
import {
  behaviorAccepted,
  citationAddressRecall,
  citationValidity,
  detectRefusal,
  groundedAnswer,
  sourceTypeRecall,
} from "./scorers";

/** The per-question scorer, split out of `harness.ts` to respect the agentic size limits:
 * the harness owns the run lifecycle, this module owns one question's verdict. */

/** Score one question from its answer text, trace events, and the citations frame
 * when the transport carried one. A question passes only when behaviour, both
 * recall dimensions and citation validity are all complete — the address dimension
 * excepted when the run gates only on the others (`gateAddressRecall: false`). The
 * trap rule's residual lives in `behaviorAccepted`. */
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
    | "expansionOrigin"
    | "gateAddressRecall"
    | "lookupOrigin"
  >,
  frame?: CitationFrameLike | null,
): EvalResultOutcome {
  const retrieval = events.filter((e) => e.kind === "retrieval").at(-1);
  const chunks = retrieval?.detail?.chunks ?? [];
  const sourceTypes = sourceTypeRecall(question.expectedSourceTypes, chunks, deps.sourceTypeOf);
  const addressRecall = citationAddressRecall(
    question.requiredCitations,
    chunks,
    deps.citationOf,
    deps.citationGrammar,
  );
  const citations = citationValidity(question.requiredCitations, answerText, {
    frame,
    events,
    ...(deps.citationGrammar !== undefined ? { grammar: deps.citationGrammar } : {}),
    ...(deps.citationIdentity !== undefined ? { identity: deps.citationIdentity } : {}),
  });
  // Quote fidelity is measured only when the answer quotes something: an answer that quotes
  // nothing (a refusal, or a plain statement) has no fidelity to score, and a 1 for it would
  // read as "its evidence checks out".
  const refused = detectRefusal(events, answerText, deps.refusalMarkers ?? []);
  const grounded = groundedAnswer({ frame, events });
  const correct = behaviorAccepted(question.expectedBehavior, refused, grounded);
  const passed =
    correct &&
    citations === 1 &&
    sourceTypes === 1 &&
    (deps.gateAddressRecall === false || addressRecall === 1);
  return {
    questionId: question.id,
    expectedBehavior: question.expectedBehavior,
    passed,
    sourceTypeRecall: sourceTypes,
    citationAddressRecall: addressRecall,
    citationValidity: citations,
    ...quoteFidelityOutcome(answerText, frame),
    refused,
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
