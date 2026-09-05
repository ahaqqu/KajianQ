import { Effect, Schedule, type Duration } from "effect";
import {
  ProviderError,
  type EmbedSpec,
  type EmbeddingResult,
  type GenerationResult,
  type PromptSpec,
  type Provider,
  type StreamHandle,
} from "@app/rag-core";
import type { ProviderConfig } from "./provider-config";
import { resolveChain } from "./provider-config";
import { createChatCompletionsProvider, isRetryable, type FetchLike } from "./chat-completions-adapter";

/**
 * The fallback chain wrapper (ADR-0022): one Provider that walks a role's
 * ordered candidates on retryable failures (transport, 429, 5xx). The
 * CostRecord carries whichever candidate actually answered, so a Trace shows
 * the fallback. An exhausted chain throws a typed ProviderError listing the
 * candidates attempted.
 */
export type ResolveOptions = {
  /** Env source for API keys — Workers bindings in the api, process.env in CLI. */
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Per-kind backoff schedule; defaults to `defaultRetrySchedule`. */
  retrySchedule?: Schedule.Schedule<unknown, ProviderError>;
};

/** Build the concrete adapter for one parsed candidate. */
function buildCandidate(
  candidate: ReturnType<typeof resolveChain>[number],
  opts: ResolveOptions,
): Provider {
  if (candidate.vendorConfig.protocol !== "chat-completions") {
    throw new Error(
      `provider factory: protocol "${candidate.vendorConfig.protocol}" has no adapter`,
    );
  }
  const apiKey = opts.env[candidate.vendorConfig.apiKeyEnv];
  if (!apiKey) {
    // The missing-key filter in resolveRole is the single source of truth;
    // this guard keeps buildCandidate safe for any future direct caller —
    // an empty key would send a bare "Bearer " header to the vendor.
    throw new ProviderError({
      kind: "bad_request",
      message: `candidate ${candidate.vendor}:${candidate.modelId} has no API key (${candidate.vendorConfig.apiKeyEnv})`,
    });
  }
  return createChatCompletionsProvider({
    vendor: candidate.vendorConfig,
    modelId: candidate.modelId,
    model: candidate.modelConfig,
    apiKey,
    ...(opts.fetchImpl != null ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

/** One wired candidate: its adapter plus its privacy posture. */
type WiredCandidate = {
  provider: Provider;
  personalDataAllowed: boolean;
};

/**
 * Per-kind retry policy for one candidate (ADR-0027 need 2: the fallback
 * wrapper previously had no backoff at all). A `rate_limited` candidate backs
 * off slower and fewer times (the vendor asked us to slow down); transport
 * and server faults retry faster; `bad_request`/`exhausted` never retry.
 * Tests inject a faster schedule via `ResolveOptions.retrySchedule`.
 */
export const perKindRetrySchedule = (
  rateLimitedBase: Duration.DurationInput,
  faultBase: Duration.DurationInput,
): Schedule.Schedule<unknown, ProviderError> =>
  Schedule.union(
    Schedule.exponential(rateLimitedBase, 2).pipe(
      Schedule.compose(Schedule.recurs(2)),
      Schedule.whileInput((err: ProviderError) => err.kind === "rate_limited"),
    ),
    Schedule.exponential(faultBase, 2).pipe(
      Schedule.compose(Schedule.recurs(3)),
      Schedule.whileInput(
        (err: ProviderError) => isRetryable(err.kind) && err.kind !== "rate_limited",
      ),
    ),
  );

export const defaultRetrySchedule: Schedule.Schedule<unknown, ProviderError> =
  perKindRetrySchedule("500 millis", "50 millis");

class FallbackProvider implements Provider {
  /**
   * The primary candidate's model id — wiring metadata only. Per-call cost
   * records carry the model that actually answered, which may be any chain
   * member after a fallback.
   */
  readonly modelId: string;

  constructor(
    private readonly config: ProviderConfig,
    private readonly role: string,
    private readonly candidates: readonly WiredCandidate[],
    private readonly missingKeys: readonly string[],
    private readonly retrySchedule: Schedule.Schedule<unknown, ProviderError> = defaultRetrySchedule,
  ) {
    this.modelId = candidates[0]?.provider.modelId ?? role;
  }

  /**
   * Filter for the call's privacy label: a personal-data call skips
   * candidates whose vendor disallows it (free tiers — ADR-0009: never
   * route personal data through free tiers).
   */
  private eligibleEffectFor(
    spec: { personalData?: boolean },
  ): Effect.Effect<readonly WiredCandidate[], ProviderError> {
    if (!spec.personalData) return Effect.succeed(this.candidates);
    const eligible = this.candidates.filter((c) => c.personalDataAllowed);
    if (eligible.length === 0 && this.candidates.length > 0) {
      return Effect.fail(
        new ProviderError({
          kind: "bad_request",
          message: `role "${this.role}": personal-data call but no candidate allows personal data ` +
            `(candidates: ${this.candidates.map((c) => c.provider.modelId).join(", ")})`,
        }),
      );
    }
    return Effect.succeed(eligible);
  }

  /**
   * Walk the chain in order: a retryable failure (transport, 429, 5xx) moves
   * to the next candidate; anything else fails immediately. An exhausted
   * chain fails with a typed `ProviderError` listing the candidates attempted.
   * (Per-kind backoff schedules arrive with the infra phase of ADR-0027.)
   */
  private withFallback<A>(
    op: (p: Provider) => Effect.Effect<A, ProviderError>,
  ): (eligible: readonly WiredCandidate[]) => Effect.Effect<A, ProviderError> {
    return (eligible) => {
      if (eligible.length === 0) {
        return Effect.fail(
          new ProviderError({
            kind: "bad_request",
            message: `role "${this.role}": no candidate has an API key (missing: ${this.missingKeys.join(", ")})`,
          }),
        );
      }
      const first = eligible[0];
      if (first === undefined) {
        return Effect.fail(
          new ProviderError({ kind: "bad_request", message: `role "${this.role}": no candidates wired` }),
        );
      }
      const schedule = this.retrySchedule;
      const retried = (candidate: WiredCandidate): Effect.Effect<A, ProviderError> =>
        op(candidate.provider).pipe(Effect.retry({ schedule: schedule as Schedule.Schedule<unknown, ProviderError> }));
      const rest = eligible.slice(1);
      const chain = rest.reduce<Effect.Effect<A, ProviderError>>(
        (acc, candidate) =>
          acc.pipe(
            Effect.catchAll((err) =>
              isRetryable(err.kind) ? retried(candidate) : Effect.fail(err),
            ),
          ),
        retried(first),
      );
      return chain.pipe(
        Effect.catchAll((lastError) =>
          isRetryable(lastError.kind)
            ? Effect.fail(
                new ProviderError({
                  kind: "exhausted",
                  message: `role "${this.role}": all candidates failed (last: ${lastError.message})`,
                  candidates: eligible.map((c) => c.provider.modelId),
                }),
              )
            : Effect.fail(lastError),
        ),
      );
    };
  }

  generate(spec: PromptSpec): Effect.Effect<GenerationResult, ProviderError> {
    return Effect.flatMap(this.eligibleEffectFor(spec), this.withFallback((p) => p.generate(spec)));
  }

  stream(spec: PromptSpec): Effect.Effect<StreamHandle, ProviderError> {
    return Effect.flatMap(this.eligibleEffectFor(spec), this.withFallback((p) => p.stream(spec)));
  }

  embed(spec: EmbedSpec): Effect.Effect<EmbeddingResult, ProviderError> {
    return Effect.flatMap(this.eligibleEffectFor(spec), this.withFallback((p) => p.embed(spec)));
  }
}

export type ResolvedRole = {
  provider: Provider;
  /** Candidates whose API key was absent — for the smoke script's NOT RUN report. */
  missingKeys: readonly string[];
};

/**
 * Resolve a Model Role to its fallback-chained Provider (ADR-0022). Only
 * candidates with an API key in `env` are wired into the chain; a role with
 * zero keyed candidates still returns (calls fail with a clear error listing
 * the missing env names) so wiring code never branches on key presence.
 */
export function resolveRole(
  config: ProviderConfig,
  role: string,
  opts: ResolveOptions,
): ResolvedRole {
  const candidates = resolveChain(config, role);
  const wired: WiredCandidate[] = [];
  const missingKeys: string[] = [];
  for (const candidate of candidates) {
    const key = opts.env[candidate.vendorConfig.apiKeyEnv];
    if (!key) {
      missingKeys.push(candidate.vendorConfig.apiKeyEnv);
      continue;
    }
    wired.push({
      provider: buildCandidate(candidate, opts),
      personalDataAllowed: candidate.vendorConfig.personalDataAllowed,
    });
  }
  return {
    provider: new FallbackProvider(config, role, wired, missingKeys, opts.retrySchedule),
    missingKeys,
  };
}