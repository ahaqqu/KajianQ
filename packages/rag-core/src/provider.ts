import { Data } from "effect";
import type { CostRecord } from "@app/contracts";
import type { Effect, Stream } from "effect";

/** Why a Provider call failed — retryable means "try the next candidate". */
export type ProviderErrorKind =
  /** Transport-level failure: network error, timeout, DNS. */
  | "transport"
  /** Rate limited (HTTP 429) or quota exhausted. */
  | "rate_limited"
  /** The vendor answered with a server error (HTTP 5xx). */
  | "server"
  /** The call was malformed or unauthorized (4xx other than 429). */
  | "bad_request"
  /** Everything failed; candidates is the chain that was attempted. */
  | "exhausted";

/**
 * The typed failure of a Provider call (and of an exhausted fallback chain),
 * travelling in the Effect `E` channel (ADR-0027) — a caller's signatures say
 * so instead of discovering failure modes by reading implementations.
 * `candidates` on an `exhausted` error lists the model ids attempted, in
 * order, so the failure is traceable without a Trace event of its own.
 */
export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly kind: ProviderErrorKind;
  readonly message: string;
  readonly candidates?: readonly string[];
}> {}

/** The text prompt and parameters for a generation or stream call. */
export type PromptSpec = {
  /** Ordered messages; roles are opaque to the engine (domain pack names them). */
  turns: readonly { role: string; content: string }[];
  /** Opaque per-model settings (e.g. temperature) — adapters pass them through. */
  options?: Record<string, unknown>;
  /**
   * True when the prompt content is personal data. The wiring layer must
   * skip free-tier candidates for such calls (ADR-0009: never route
   * personal data through free tiers).
   */
  personalData?: boolean;
};

/** A non-streamed generation result: the text plus its metered cost. */
export type GenerationResult = {
  text: string;
  cost: CostRecord;
};

/**
 * A streamed generation (ADR-0022, ADR-0027): a `Stream` of text deltas —
 * whose failure channel is `ProviderError` and whose interruption propagates
 * into the provider fetch — plus the call's `CostRecord`, which resolves only
 * once the stream completes. The caller must record the resolved cost through
 * the run's trace sink — dropping it is a rule-4 defect (untraced LLM call).
 */
export type StreamHandle = {
  deltas: Stream.Stream<string, ProviderError>;
  /** Resolves when the stream ends; fails with `ProviderError` mid-flight. */
  cost: () => Effect.Effect<CostRecord, ProviderError>;
};

/** The input to an embedding call and the dimensionality it asks for. */
export type EmbedSpec = {
  texts: readonly string[];
  /** Requested output dimensions where the model supports truncation (MRL). */
  dimensions?: number;
  /** True when the embedded texts are personal data (see PromptSpec). */
  personalData?: boolean;
};

/** An embedding result: vectors (row-aligned with the input texts) plus cost. */
export type EmbeddingResult = {
  vectors: readonly number[][];
  cost: CostRecord;
};

/**
 * The single seam for all LLM/embedding calls (ADR-0009, ADR-0022, ADR-0027).
 * Model identity arrives as an opaque string resolved from config at wiring
 * time — the interface never names a vendor. Implementations live behind it
 * in `packages/infra`; every method returns the call's `CostRecord` so the
 * caller can record tokens/latency/model/cost into the run's trace (AGENTS.md
 * rule 4).
 */
export interface Provider {
  /** Which model this instance calls — recorded into every CostRecord. */
  readonly modelId: string;
  generate(spec: PromptSpec): Effect.Effect<GenerationResult, ProviderError>;
  stream(spec: PromptSpec): Effect.Effect<StreamHandle, ProviderError>;
  embed(spec: EmbedSpec): Effect.Effect<EmbeddingResult, ProviderError>;
}
