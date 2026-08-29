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
  return createChatCompletionsProvider({
    vendor: candidate.vendorConfig,
    modelId: candidate.modelId,
    model: candidate.modelConfig,
    apiKey: opts.env[candidate.vendorConfig.apiKeyEnv] ?? "",
    ...(opts.fetchImpl != null ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

class FallbackProvider implements Provider {
  readonly modelId: string;

  constructor(
    private readonly config: ProviderConfig,
    private readonly role: string,
    private readonly providers: readonly Provider[],
    private readonly missingKeys: readonly string[],
  ) {
    this.modelId = providers[0]?.modelId ?? role;
  }

  private async withFallback<T>(op: (p: Provider) => Promise<T>): Promise<T> {
    if (this.providers.length === 0) {
      throw new ProviderError(
        "bad_request",
        `role "${this.role}": no candidate has an API key (missing: ${this.missingKeys.join(", ")})`,
      );
    }
    let lastError: ProviderError | undefined;
    for (const provider of this.providers) {
      try {
        return await op(provider);
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
      this.providers.map((p) => p.modelId),
    );
  }

  generate(spec: PromptSpec): Promise<GenerationResult> {
    return this.withFallback((p) => p.generate(spec));
  }

  stream(spec: PromptSpec): Promise<StreamHandle> {
    return this.withFallback((p) => p.stream(spec));
  }

  embed(spec: EmbedSpec): Promise<EmbeddingResult> {
    return this.withFallback((p) => p.embed(spec));
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
  const wired: Provider[] = [];
  const missingKeys: string[] = [];
  for (const candidate of candidates) {
    const key = opts.env[candidate.vendorConfig.apiKeyEnv];
    if (!key) {
      missingKeys.push(candidate.vendorConfig.apiKeyEnv);
      continue;
    }
    wired.push(buildCandidate(candidate, opts));
  }
  return {
    provider: new FallbackProvider(config, role, wired, missingKeys),
    missingKeys,
  };
}