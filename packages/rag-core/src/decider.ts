import { type Effect } from "effect";
import type { CostRecord } from "@app/contracts";
import { ProviderError } from "./provider";

/**
 * The decision-model seam (ADR-0042): a model that answers typed structured
 * questions over a state instead of generating text. It is a separate seam —
 * not a `Provider` method — because it neither generates nor embeds; a
 * decision vendor cannot stand in for a chat candidate and vice versa. Like
 * `Provider`, model identity arrives as an opaque config-resolved string and
 * every call returns its `CostRecord` so the caller records it (rule 4).
 */

/** A yes/no question; the answer is the probability the answer is yes (0..1). */
export type NoulQuestion = {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria?: { readonly true: string; readonly false: string };
};

/** Pick one option from a defined set; the answer names the picked option. */
export type ChoiceQuestion = {
  readonly type: "choice";
  readonly instructions: string;
  /** Option id → rubric description (null when no detail is needed). */
  readonly criteria: Readonly<Record<string, string | null>>;
};

/** Rate against ordered rubric levels; the answer is a probability-weighted score. */
export type ScoreQuestion = {
  readonly type: "score";
  readonly instructions: string;
  /** Ordered level descriptions, weakest first. */
  readonly criteria: readonly [string, ...string[]];
};

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** The input to a decision call: a state plus the questions to answer. */
export type DecisionSpec = {
  /** The content to evaluate (text, JSON, or an array). */
  readonly state: string | Readonly<Record<string, unknown>> | readonly unknown[];
  /** Question id → question; answers return under the same ids. */
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
};

export type NoulAnswer = {
  readonly type: "noul";
  readonly noul: number;
};

export type ChoiceAnswer = {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
};

export type ScoreAnswer = {
  readonly type: "score";
  readonly score: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
};

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** A decision result: answers keyed by question id, plus the metered cost. */
export type DecisionResult = {
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  readonly cost: CostRecord;
};

/**
 * The seam interface. Implementations live behind it in `packages/infra`,
 * driven entirely by config data (endpoint, model id, prices — ADR-0022);
 * failures travel as `ProviderError` so retry/fallback policy is uniform
 * across both seams.
 */
export interface Decider {
  /** Which model this instance calls — recorded into every CostRecord. */
  readonly modelId: string;
  decide(spec: DecisionSpec): Effect.Effect<DecisionResult, ProviderError>;
}
