import type {
  EmbedSpec,
  EmbeddingResult,
  GenerationResult,
  PromptSpec,
  Provider,
  StreamHandle,
} from "@app/rag-core";
import { ProviderError } from "@app/rag-core";
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
    throw new ProviderError(
      "bad_request",
      `candidate ${candidate.vendor}:${candidate.modelId} has no API key (${candidate.vendorConfig.apiKeyEnv})`,
    );
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
  ) {
    this.modelId = candidates[0]?.provider.modelId ?? role;
  }

  /**
   * Filter for the call's privacy label: a personal-data call skips
   * candidates whose vendor disallows it (free tiers — ADR-0009: never
   * route personal data through free tiers).
   */
  private eligibleFor(spec: { personalData?: boolean }): readonly WiredCandidate[] {
    if (!spec.personalData) return this.candidates;
    const eligible = this.candidates.filter((c) => c.personalDataAllowed);
    if (eligible.length === 0 && this.candidates.length > 0) {
      throw new ProviderError(
        "bad_request",
        `role "${this.role}": personal-data call but no candidate allows personal data ` +
          `(candidates: ${this.candidates.map((c) => c.provider.modelId).join(", ")})`,
      );
    }
    return eligible;
  }

  private async withFallback<T>(
    eligible: readonly WiredCandidate[],
    op: (p: Provider) => Promise<T>,
  ): Promise<T> {
    if (eligible.length === 0) {
      throw new ProviderError(
        "bad_request",
        `role "${this.role}": no candidate has an API key (missing: ${this.missingKeys.join(", ")})`,
      );
    }
    let lastError: ProviderError | undefined;
    for (const candidate of eligible) {
      try {
        return await op(candidate.provider);
      } catch (err) {
        if (err instanceof ProviderError && isRetryable(err.kind)) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw new ProviderError(
      "exhausted",
      `role "${this.role}": all candidates failed (last: ${lastError?.message ?? "unknown"})`,
      eligible.map((c) => c.provider.modelId),
    );
  }

  async generate(spec: PromptSpec): Promise<GenerationResult> {
    return this.withFallback(this.eligibleFor(spec), (p) => p.generate(spec));
  }

  async stream(spec: PromptSpec): Promise<StreamHandle> {
    return this.withFallback(this.eligibleFor(spec), (p) => p.stream(spec));
  }

  async embed(spec: EmbedSpec): Promise<EmbeddingResult> {
    return this.withFallback(this.eligibleFor(spec), (p) => p.embed(spec));
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
    provider: new FallbackProvider(config, role, wired, missingKeys),
    missingKeys,
  };
}