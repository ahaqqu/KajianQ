import { Effect, type Schedule } from "effect";
import {
  type CostRecord,
  ProviderError,
  type EmbedSpec,
  type EmbeddingResult,
  type GenerationResult,
  type PromptSpec,
  type Provider,
  type StreamHandle,
} from "@app/rag-core";
import { defaultRetrySchedule } from "./retry-schedule";
import { resolveChain, type ProviderConfig } from "./provider-config";
import {
  createChatCompletionsProvider,
  isRetryable,
  type FetchLike,
} from "./chat-completions-adapter";

/**
 * The fallback chain wrapper (ADR-0022): one Provider that walks a role's
 * ordered candidates on retryable failures (transport, 429, 5xx). The
 * CostRecord carries whichever candidate actually answered, so a Trace shows
 * the fallback. An exhausted chain throws a typed ProviderError listing the
 * candidates attempted.
 *
 * Retry policy (ADR-0027 need 2): each candidate retries its own transient
 * failures under a per-kind schedule — `rate_limited` backs off slower with
 * fewer retries (the vendor asked us to slow down), transport/server faults
 * retry faster with a larger budget, and non-retryable kinds fail through to
 * the next candidate immediately. The schedule is configurable per call site
 * via `ResolveOptions.retrySchedule` (tests inject a fast policy); the
 * checked-in default is `defaultRetrySchedule`.
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
    private readonly retrySchedule: Schedule.Schedule<
      unknown,
      ProviderError
    > = defaultRetrySchedule,
  ) {
    this.modelId = candidates[0]?.provider.modelId ?? role;
  }

  /**
   * Filter for the call's privacy label: a personal-data call skips
   * candidates whose vendor disallows it (free tiers — ADR-0009: never
   * route personal data through free tiers).
   */
  private eligibleEffectFor(spec: {
    personalData?: boolean;
  }): Effect.Effect<readonly WiredCandidate[], ProviderError> {
    if (!spec.personalData) return Effect.succeed(this.candidates);
    const eligible = this.candidates.filter((c) => c.personalDataAllowed);
    if (eligible.length === 0 && this.candidates.length > 0) {
      return Effect.fail(
        new ProviderError({
          kind: "bad_request",
          message:
            `role "${this.role}": personal-data call but no candidate allows personal data ` +
            `(candidates: ${this.candidates.map((c) => c.provider.modelId).join(", ")})`,
        }),
      );
    }
    return Effect.succeed(eligible);
  }

  /**
   * Walk the chain in order: a retryable failure (transport, 429, 5xx) first
   * exhausts the candidate's per-kind retry schedule, then moves to the next
   * candidate; anything else fails immediately. An exhausted chain fails
   * with a typed `ProviderError` listing the candidates attempted.
   *
   * Cost trail (C2, traceability rule 4): every attempt that reached the
   * vendor carries its CostRecord on the failing `ProviderError`
   * (`attemptCosts`). Retries and fallbacks accumulate, so the error the
   * caller finally sees lists each vendor-reaching failed attempt in order —
   * a failed call may never drop spend from the cost trail. (Successes
   * carry only the winning attempt's cost today; spend from attempts that
   * failed before a later candidate succeeded is surfaced in the trace via
   * the failed-attempt records of any subsequent failure, and recording it
   * on the success path needs a contracts change — flagged for follow-up.)
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
      // Costs of vendor-reaching failed attempts, accumulated across the
      // whole chain walk — a later candidate's success does not undo earlier
      // candidates' spend, and the final failure carries the full trail.
      const chainCosts: CostRecord[] = [];
      /** One candidate: each failed attempt's spend is collected as it
       * passes through the retry loop; when the candidate gives up, the
       * escaping error carries every vendor-reaching attempt's cost in
       * order (C2 — a retried-away attempt may not vanish from the trail). */
      const retried = (candidate: WiredCandidate): Effect.Effect<A, ProviderError> => {
        const costs: CostRecord[] = [];
        const collect = (err: ProviderError): void => {
          if (err.attemptCosts !== undefined) costs.push(...err.attemptCosts);
        };
        return op(candidate.provider).pipe(
          // Collect each failure's spend as it passes into the retry loop —
          // retried or not — then re-fail with the same error so the
          // schedule's kind dispatch is untouched. (Effect v4: tap-and-refail
          // is `tapError`; `catchAll` is gone.)
          Effect.tapError((err: ProviderError) => Effect.sync(() => collect(err))),
          Effect.retry({ schedule: this.retrySchedule }),
          // The candidate gave up: stamp the accumulated list onto the
          // escaping error and move the spend to the chain level. (No
          // second collect here — the pre-retry hook already collected
          // this failure's cost; collecting again would double-count the
          // last attempt.) `catchIf` with an always-true predicate is the
          // v4 form of the former `catchAll`.
          Effect.catchIf(
            () => true,
            (err: ProviderError) => {
              chainCosts.push(...costs);
              return Effect.fail(
                costs.length > 0
                  ? new ProviderError({
                      kind: err.kind,
                      message: err.message,
                      ...(err.candidates !== undefined ? { candidates: err.candidates } : {}),
                      attemptCosts: costs,
                    })
                  : err,
              );
            },
          ),
        );
      };
      // `eligible` is non-empty here (the empty-list case failed above); the
      // non-null assertion is bounded to this one line.
      const first = eligible[0]!;
      const rest = eligible.slice(1);
      const chain = rest.reduce<Effect.Effect<A, ProviderError>>(
        (acc, candidate) =>
          acc.pipe(
            // Non-retryable kinds pass through untouched (the v4 conditional
            // catch keeps the v3 `isRetryable ? next : re-fail` shape).
            Effect.catchIf(
              (err) => isRetryable(err.kind),
              () => retried(candidate),
            ),
          ),
        retried(first),
      );
      return chain.pipe(
        Effect.catchIf(
          (lastError) => isRetryable(lastError.kind),
          (lastError) =>
            Effect.fail(
              new ProviderError({
                kind: "exhausted",
                message: `role "${this.role}": all candidates failed (last: ${lastError.message})`,
                candidates: eligible.map((c) => c.provider.modelId),
                attemptCosts: chainCosts,
              }),
            ),
        ),
      );
    };
  }

  generate(spec: PromptSpec): Effect.Effect<GenerationResult, ProviderError> {
    return Effect.flatMap(
      this.eligibleEffectFor(spec),
      this.withFallback((p) => p.generate(spec)),
    );
  }

  stream(spec: PromptSpec): Effect.Effect<StreamHandle, ProviderError> {
    return Effect.flatMap(
      this.eligibleEffectFor(spec),
      this.withFallback((p) => p.stream(spec)),
    );
  }

  embed(spec: EmbedSpec): Effect.Effect<EmbeddingResult, ProviderError> {
    return Effect.flatMap(
      this.eligibleEffectFor(spec),
      this.withFallback((p) => p.embed(spec)),
    );
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
