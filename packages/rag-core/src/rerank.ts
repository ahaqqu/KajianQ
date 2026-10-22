import { Cause, Effect } from "effect";
import type { Chunk, Retriever } from "./pipeline";
import { RunContext, type RunContextService } from "./context";
import type { ChoiceQuestion, Decider, DecisionAnswer, DecisionSpec } from "./decider";
import {
  recordRerank,
  recordRerankAttemptCosts,
  recordRerankCall,
  rerankItems,
} from "./rerank-trace";

/**
 * The decision-model rerank decorator (ADR-0042's seam applied to retrieval):
 * one `Choice` question over the fused candidates, reordered by the returned
 * probability distribution before the assembler spends the context budget on
 * them. It is a `Retriever` decorator, not a new stage, so the runner, the
 * trace sink and the stage interfaces do not change; the question's wording is
 * the caller's, and this module names no source, language or citation.
 *
 * The fused block is the chunks with no `origin` label; a labelled chunk keeps
 * the position the wrapped retriever gave it, and the reranked fused chunks
 * fill the remaining slots. Every probability, fused score and rank lands on
 * the trace's `rerank` event, and the spend on a sibling `llm_call`, so the
 * run's trace total stays the sum of its recorded calls.
 *
 * Fail-open: a vendor failure or thrown defect, an unreadable answer, an answer
 * contradicting its own distribution, or a candidate list too short to rank
 * leaves the fused order exactly as it was, with a `preserved` event naming the
 * rule that refused it. Cancellation is re-raised, never read as a failure.
 */

/** The one question id the rerank request uses. */
export const RERANK_QUESTION_KEY = "best";

/** The `rerank`/`llm_call` events' purpose label. */
export const RERANK_PURPOSE = "rerank";

/** The option id for candidate `index`, matching the request's order. */
export function rerankCandidateKey(index: number): string {
  return `c${index}`;
}

/** Why the fused order stood; each value is one rule, documented on the
 * contract's `reason` field. */
export type RerankPreserveReason =
  | "too_few_candidates"
  | "vendor_failure"
  | "thrown"
  | "non_choice"
  | "missing_probability"
  | "choice_outside_options"
  | "out_of_range_choice"
  | "choice_not_argmax";

/** A usable distribution, or the reason the answer was unusable. */
export type RerankRead =
  | { readonly kind: "applied"; readonly probabilities: readonly number[] }
  | { readonly kind: "preserved"; readonly reason: RerankPreserveReason };

/** The request the decorator builds, or `null` when there is nothing to rank. */
export type RerankPlan = { readonly spec: DecisionSpec; readonly candidates: readonly Chunk[] };

/**
 * Build the one-`Choice`-question request over the fused candidates. `null`
 * when fewer than two candidates survived: a one-option choice question is a
 * call that cannot change anything, and the verdict is "preserved".
 */
export function planRerank(input: {
  query: string;
  candidates: readonly Chunk[];
  instructions: string;
}): RerankPlan | null {
  if (input.candidates.length < 2) return null;
  const criteria: Record<string, string | null> = {};
  input.candidates.forEach((_, index) => {
    criteria[rerankCandidateKey(index)] = null;
  });
  return {
    candidates: input.candidates,
    spec: {
      // The candidates are retrieved evidence and the state carries the user's
      // verbatim question: a declared personal-data call, so the seam can
      // refuse a vendor that forbids it.
      personalData: true,
      state: {
        query: input.query,
        candidates: input.candidates.map((candidate) => candidate.text),
      },
      questions: {
        [RERANK_QUESTION_KEY]: {
          type: "choice",
          instructions: input.instructions,
          criteria,
        } satisfies ChoiceQuestion,
      },
    },
  };
}

/**
 * Read the vendor's distribution through the seam's typed union. The answer is
 * untrusted wire data: every candidate needs a finite probability in 0..1, the
 * named choice must be an offered candidate key, and it must be a positive
 * maximum of the distribution it came with.
 *
 * The argmax rule is not redundant with the ranking: the committed decision
 * bench scores the named choice, not the distribution, so an answer whose two
 * outputs disagree has no ranking this module can defend. Preserve it with
 * `choice_not_argmax`, never resolve it in the distribution's favour.
 */
export function readRerankAnswer(answer: DecisionAnswer | undefined, count: number): RerankRead {
  if (answer === undefined || answer.type !== "choice") {
    return { kind: "preserved", reason: "non_choice" };
  }
  const raw: unknown = answer.probabilities;
  if (raw === null || typeof raw !== "object") {
    return { kind: "preserved", reason: "missing_probability" };
  }
  const record = raw as Record<string, unknown>;
  const probabilities: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = record[rerankCandidateKey(index)];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return { kind: "preserved", reason: "missing_probability" };
    }
    probabilities.push(value);
  }
  const choice: unknown = answer.choice;
  const match = typeof choice === "string" ? /^c(\d+)$/.exec(choice) : null;
  if (match?.[1] === undefined) {
    return { kind: "preserved", reason: "choice_outside_options" };
  }
  const chosenIndex = Number(match[1]);
  if (chosenIndex >= count) {
    return { kind: "preserved", reason: "out_of_range_choice" };
  }
  const max = Math.max(...probabilities);
  // A distribution with no mass names no winner; an answer whose pick is not a
  // maximum contradicts the distribution it came with.
  if (max <= 0 || probabilities[chosenIndex] !== max) {
    return { kind: "preserved", reason: "choice_not_argmax" };
  }
  return { kind: "applied", probabilities };
}

/**
 * Rank candidate positions by descending probability. Ties keep the fused
 * order, compared explicitly rather than relying on the sort's stability, so
 * the same answer always produces the same sequence.
 */
export function rankCandidates(probabilities: readonly number[]): {
  order: readonly number[];
  rankAfter: readonly number[];
} {
  const order = probabilities
    .map((probability, index) => ({ probability, index }))
    .sort((a, b) => b.probability - a.probability || a.index - b.index)
    .map((entry) => entry.index);
  const rankAfter: number[] = new Array(probabilities.length).fill(0);
  order.forEach((index, rank) => {
    rankAfter[index] = rank;
  });
  return { order, rankAfter };
}

export type RerankOptions = {
  /** The serving decision model; the caller resolves it from config. */
  decider: Decider;
  /** The domain pack's language-neutral Choice instruction (opaque here). */
  instructions: string;
};

/**
 * Wrap a retriever in the decision-model rerank. Only the fused block is
 * reordered: every chunk that carries an `origin` label keeps the position the
 * wrapped retriever gave it, and the reranked fused chunks fill the remaining
 * slots.
 */
export function createRerankedRetriever<TFilters extends Record<string, unknown>>(
  inner: Retriever<TFilters>,
  options: RerankOptions,
): Retriever<TFilters> {
  return {
    retrieve: (routed) =>
      Effect.gen(function* () {
        const chunks = yield* inner.retrieve(routed);
        const run = yield* RunContext;
        return yield* rerankCandidates({
          query: routed.sourceText,
          chunks,
          decider: options.decider,
          instructions: options.instructions,
          run,
        });
      }),
  };
}

/**
 * Run the rerank over one retrieval result, recording its trace events. Total
 * in the failure sense: the returned effect never fails, so the wrapped
 * retriever's error channel is exactly the inner retriever's. Cancellation is
 * re-raised rather than caught.
 */
function rerankCandidates(input: {
  query: string;
  chunks: readonly Chunk[];
  decider: Decider;
  instructions: string;
  run: Pick<RunContextService, "now" | "record">;
}): Effect.Effect<readonly Chunk[]> {
  const fused = input.chunks.filter((candidate) => candidate.origin === undefined);
  if (fused.length < 2) {
    recordRerank(input.run, RERANK_PURPOSE, {
      outcome: "preserved",
      reason: "too_few_candidates",
      items: rerankItems(fused),
    });
    return Effect.succeed(input.chunks);
  }

  const plan = planRerank({
    query: input.query,
    candidates: fused,
    instructions: input.instructions,
  });
  // Unreachable — the length guard above — but the narrowing keeps the plan's
  // nullability out of the effect body.
  if (plan === null) return Effect.succeed(input.chunks);

  return Effect.suspend(() => input.decider.decide(plan.spec)).pipe(
    // The full cause, so a thrown defect falls open like a typed vendor
    // failure: the decision model may never take the retrieval path down.
    Effect.sandbox,
    Effect.matchEffect({
      onSuccess: (result) =>
        Effect.sync(() => {
          recordRerankCall(input.run, RERANK_PURPOSE, result.cost);
          const read = readRerankAnswer(result.answers[RERANK_QUESTION_KEY], fused.length);
          if (read.kind === "preserved") {
            recordRerank(input.run, RERANK_PURPOSE, {
              outcome: "preserved",
              reason: read.reason,
              items: rerankItems(fused),
            });
            return input.chunks;
          }
          const { order, rankAfter } = rankCandidates(read.probabilities);
          recordRerank(input.run, RERANK_PURPOSE, {
            outcome: "applied",
            items: rerankItems(fused, read.probabilities, rankAfter),
          });
          const reranked = order.map((index) => {
            const candidate = fused[index];
            const probability = read.probabilities[index];
            if (candidate === undefined || probability === undefined) {
              throw new Error("rerank: ranked position outside the fused block");
            }
            return { ...candidate, rerankScore: probability };
          });
          // Fill only the fused slots: a labelled chunk keeps its own position.
          const out: Chunk[] = [];
          let next = 0;
          for (const candidate of input.chunks) {
            if (candidate.origin !== undefined) {
              out.push(candidate);
              continue;
            }
            const ranked = reranked[next];
            if (ranked === undefined)
              throw new Error("rerank: fused slot outside the reranked block");
            out.push(ranked);
            next += 1;
          }
          return out;
        }),
      onFailure: (cause) => {
        // Cancellation is not a vendor failure: a cancelled run stays cancelled.
        if (isCancellation(cause)) return Effect.interrupt;
        recordRerankAttemptCosts(input.run, RERANK_PURPOSE, cause);
        recordRerank(input.run, RERANK_PURPOSE, {
          outcome: "preserved",
          // A typed failure came through the seam's channel; anything else is
          // a defect the sandbox caught. The trace names which.
          reason: Cause.hasFails(cause) ? "vendor_failure" : "thrown",
          items: rerankItems(fused),
        });
        return Effect.succeed(input.chunks);
      },
    }),
  );
}

/** True when a sandboxed cause is a cancellation only — never fail open on it. */
function isCancellation(cause: Parameters<typeof Cause.squash>[0]): boolean {
  return Cause.hasInterruptsOnly(cause);
}
