import { Effect } from "effect";
import type { Chunk, Retriever } from "./pipeline";
import { RunContext, type RunContextService } from "./context";
import type { ChoiceQuestion, Decider, DecisionAnswer, DecisionSpec } from "./decider";
import {
  isCancellation,
  recordRerank,
  recordRerankAttemptCosts,
  recordRerankCall,
  rerankItems,
} from "./rerank-trace";

/**
 * The decision-model rerank decorator (ADR-0042's seam applied to retrieval):
 * one `Choice` question over the fused candidates, reordered by the returned
 * probability distribution before the assembler spends the context budget on
 * them.
 *
 * It is a `Retriever` decorator, not a new stage, so the runner, the trace sink
 * and the stage interfaces do not change: the wrapped retriever produces the
 * fused candidates exactly as before, and this wrapper reorders them. The
 * question's wording is the CALLER's — the domain pack passes the
 * language-neutral instruction its multilingual gate benchmarked — so this
 * module names no source, language or citation; it carries an opaque
 * `DecisionSpec` to the seam.
 *
 * The fused tracks' chunks are the ones with no `origin` label (the engine's
 * documented fused marker); a chunk another path added keeps its label and its
 * place after the fused block. Every probability, fused score and rank lands on
 * the trace's `rerank` event, and the spend on a sibling `llm_call`, so the
 * run's trace total stays the sum of its recorded calls.
 *
 * Fail-open: a vendor failure (a defect included), an unusable answer, an
 * answer contradicting its own distribution, or a candidate list too short to
 * rank leaves the fused order exactly as it was, with a `preserved` event
 * naming why. The failure this prevents is the reverse: a missing or
 * nonsensical answer read as a ranking, silently reordering the evidence a
 * grounding answer is built from.
 */

/** The one question id the rerank request uses. */
export const RERANK_QUESTION_KEY = "best";

/** The `rerank`/`llm_call` events' purpose label. */
export const RERANK_PURPOSE = "rerank";

/** The option id for candidate `index`, matching the request's order. */
export function rerankCandidateKey(index: number): string {
  return `c${index}`;
}

/** Why a rerank read left the fused order untouched. */
export type RerankPreserveReason = "malformed_answer" | "ambiguous_answer";

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
 * named choice must be one of the options, and it must be (one of) the
 * distribution's maxima — an answer that contradicts its own distribution is
 * ambiguous, never silently resolved in the distribution's favour.
 */
export function readRerankAnswer(answer: DecisionAnswer | undefined, count: number): RerankRead {
  if (answer === undefined || answer.type !== "choice") {
    return { kind: "preserved", reason: "malformed_answer" };
  }
  const raw: unknown = answer.probabilities;
  if (raw === null || typeof raw !== "object") {
    return { kind: "preserved", reason: "malformed_answer" };
  }
  const record = raw as Record<string, unknown>;
  const probabilities: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = record[rerankCandidateKey(index)];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return { kind: "preserved", reason: "malformed_answer" };
    }
    probabilities.push(value);
  }
  const choice: unknown = answer.choice;
  const match = typeof choice === "string" ? /^c(\d+)$/.exec(choice) : null;
  const chosenIndex = match?.[1] === undefined ? null : Number(match[1]);
  if (chosenIndex === null || chosenIndex >= count) {
    return { kind: "preserved", reason: "ambiguous_answer" };
  }
  const max = Math.max(...probabilities);
  // A distribution with no mass names no winner; an answer whose pick is not a
  // maximum contradicts the distribution it came with.
  if (max <= 0 || probabilities[chosenIndex] !== max) {
    return { kind: "preserved", reason: "ambiguous_answer" };
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
  /** The `rerank`/`llm_call` purpose label; defaults to `rerank`. */
  purpose?: string;
};

/**
 * Wrap a retriever in the decision-model rerank. The wrapped list's fused
 * block is reordered; caller-labelled chunks follow it in their own order.
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
          purpose: options.purpose ?? RERANK_PURPOSE,
          run,
        });
      }),
  };
}

/**
 * Run the screen over one retrieval result, recording its trace events. Total
 * in the failure sense: the returned effect never fails, so the wrapped
 * retriever's error channel is exactly the inner retriever's.
 */
function rerankCandidates(input: {
  query: string;
  chunks: readonly Chunk[];
  decider: Decider;
  instructions: string;
  purpose: string;
  run: Pick<RunContextService, "now" | "record">;
}): Effect.Effect<readonly Chunk[]> {
  const fused = input.chunks.filter((candidate) => candidate.origin === undefined);
  const others = input.chunks.filter((candidate) => candidate.origin !== undefined);
  if (fused.length < 2) {
    recordRerank(input.run, input.purpose, {
      outcome: "preserved",
      reason: fused.length === 0 ? "no_candidates" : "single_candidate",
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
          recordRerankCall(input.run, input.purpose, result.cost);
          const read = readRerankAnswer(result.answers[RERANK_QUESTION_KEY], fused.length);
          if (read.kind === "preserved") {
            recordRerank(input.run, input.purpose, {
              outcome: "preserved",
              reason: read.reason,
              items: rerankItems(fused),
            });
            return input.chunks;
          }
          const { order, rankAfter } = rankCandidates(read.probabilities);
          recordRerank(input.run, input.purpose, {
            outcome: "applied",
            items: rerankItems(fused, read.probabilities, rankAfter),
          });
          const reranked = order.map((index) => {
            const candidate = fused[index];
            const probability = read.probabilities[index];
            if (candidate === undefined || probability === undefined) {
              throw new Error("rerank: ranked position outside the candidate list");
            }
            return { ...candidate, rerankScore: probability };
          });
          return [...reranked, ...others];
        }),
      onFailure: (cause) => {
        // Cancellation is not a vendor failure: a cancelled run stays cancelled.
        if (isCancellation(cause)) return Effect.interrupt;
        recordRerankAttemptCosts(input.run, input.purpose, cause);
        recordRerank(input.run, input.purpose, {
          outcome: "preserved",
          reason: "vendor_failure",
          items: rerankItems(fused),
        });
        return Effect.succeed(input.chunks);
      },
    }),
  );
}
