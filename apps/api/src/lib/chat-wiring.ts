import { runStoreEffect, type StoreBridge } from "@app/kajianq-domain";
import type { Decider, Provider } from "@app/rag-core";
import {
  loadProviderConfig,
  resolveDecider,
  resolveRole,
  type Logger,
  type ProviderConfig,
  type RagStore,
} from "@app/infra";
import {
  ChatConfigError,
  createRagStoreFromEnv,
  parseNeighbourCap,
  parseNeighbourRadius,
  parseScopeExpansionCap,
} from "./chat-config";
export { authGuard } from "./auth";
// Re-exported so the chat route keeps its import count within the agentic cap.
export { answerFramesFor, rehydrateTranscript } from "./chat-citations";
export { chunkFetcher, traceRefused } from "./chat-trace";
export {
  ChatConfigError,
  createRagStoreFromEnv,
  parseNeighbourCap,
  parseNeighbourRadius,
  parseScopeExpansionCap,
} from "./chat-config";

/**
 * Env-bound wiring for the chat route: the one place the Worker's bindings become
 * seams. Route handlers read `RagStore`/`Provider`, never `env.*`.
 */

/**
 * The provider roles the chat composition root resolves: a new serving role is
 * declared here, and bench-only roles are deliberately absent.
 */
export const CHAT_SERVING_ROLES = [
  "cheap",
  "generator",
  "reviewer",
  "embedder",
  "decision",
] as const;

export type ChatProviders = {
  router: Provider;
  generator: Provider;
  reviewer: Provider | null;
  /** The reviewer's decision-model pre-gate; null when no decision candidate is
   * keyed — bound key = active, with no enable flag. */
  decider: Decider | null;
  embedder: Provider;
  missingKeys: readonly string[];
  /** Decision candidates the personal-data posture excluded: a vendor that forbids
   * personal data may never carry the pre-gate's claim spans, and the filter runs
   * before the key check, so an unkeyed candidate lands here too. */
  ineligibleKeys: readonly string[];
};

function roleHasKey(
  config: ReturnType<typeof loadProviderConfig>,
  env: Record<string, string | undefined>,
  role: string,
): boolean {
  return (
    config.roles[role]?.chain.some((key) => {
      const sep = key.indexOf(":");
      const vendor = sep > 0 ? key.slice(0, sep) : key;
      const apiKeyEnv = config.vendors[vendor]?.apiKeyEnv;
      return apiKeyEnv !== undefined && env[apiKeyEnv] !== undefined;
    }) ?? false
  );
}

/** The checked-in provider config is immutable at runtime: parse once at module load. */
const CACHED_PROVIDER_CONFIG: ProviderConfig = loadProviderConfig();

/**
 * Resolve the chat pipeline's provider roles from the checked-in config and the
 * Worker bindings. Roles without a keyed candidate resolve to a Provider whose
 * calls fail with a clear error — wiring never branches on key presence.
 *
 * The reviewer's absence is a *configuration* failure, not a degradation: it
 * carries the cross-vendor faithfulness check, so `buildChatWiring` raises a typed
 * `ChatConfigError` and the route answers 503.
 */
export function createProvidersFromEnv(
  env: Record<string, string | undefined>,
  // The config is a parameter (defaulting to the cached parse) so resolution
  // stays a pure function of (config, env), drivable by a synthetic vendor set.
  config: ProviderConfig = CACHED_PROVIDER_CONFIG,
): ChatProviders {
  const missing = new Set<string>();
  const resolve = (role: string) => {
    const { provider, missingKeys } = resolveRole(config, role, { env });
    for (const key of missingKeys) missing.add(key);
    return provider;
  };
  // The reviewer's missing keys are collected even when the role resolves to
  // null, so the ops report names the key that would unblock the reviewer.
  const reviewerMissing = resolveRole(config, "reviewer", { env }).missingKeys;
  for (const key of reviewerMissing) missing.add(key);
  // The pre-gate is active exactly when its key is bound: an absent key is reported for
  // ops, not treated as a config failure — the reviewer's own path is the fail-open
  // fallback. `personalData: true` because its claim spans are personal data.
  const decisionRole = resolveDecider(config, "decision", { env, personalData: true });
  for (const key of decisionRole.missingKeys) missing.add(key);
  return {
    router: resolve("cheap"),
    generator: resolve("generator"),
    reviewer: roleHasKey(config, env, "reviewer") ? resolve("reviewer") : null,
    // Head-first: the eligible chain's first candidate serves, and a failure
    // does not walk the rest — the caller's fail-open path is the fallback.
    decider: decisionRole.deciders[0]?.decider ?? null,
    embedder: resolve("embedder"),
    missingKeys: [...missing],
    ineligibleKeys: decisionRole.ineligibleKeys,
  };
}

/**
 * The store-seam bridge: run one Effect-signatured store call to a promise, kept in
 * the wiring so handlers hold plain promise-shaped helpers only.
 */
export function storeBridge(_store: RagStore): StoreBridge {
  return (effect) => runStoreEffect(effect);
}

export type ChatWiring = {
  pipeline: Omit<
    import("@app/kajianq-domain").ChatPipelineDeps,
    "language" | "history" | "onDelta"
  >;
  fullStore: RagStore;
  runStore: StoreBridge;
};

/**
 * The store-only wiring the auth and feedback routes need: a store plus its bridge,
 * with no provider roles resolved. Session minting and self-deletion must not be
 * gated on an unrelated LLM role — a rotated reviewer key would take down minting
 * and erasure — so the reviewer-mandatory check stays on `buildChatWiring`.
 */
export type StoreWiring = {
  fullStore: RagStore;
  runStore: StoreBridge;
};

export function buildStoreWiring(env: { DATABASE_URL?: string }): StoreWiring {
  const store = createRagStoreFromEnv(env);
  return { fullStore: store, runStore: storeBridge(store) };
}

/**
 * Build the chat wiring from the Worker bindings. Throws (config-class) when the
 * store is not configured or the reviewer role has no keyed candidate.
 */
export function buildChatWiring(env: Record<string, string | undefined>): ChatWiring {
  const providers = createProvidersFromEnv(env);
  if (providers.reviewer === null) {
    // An unreviewed answer is not a lesser answer, it is an unverified one: fail
    // closed. Checked before the store is constructed so the config error is
    // reported as a config error.
    throw new ChatConfigError(
      "chat route: reviewer role has no keyed candidate — the cross-vendor faithfulness check is mandatory",
      providers.missingKeys.join(", ") || "reviewer",
    );
  }
  const store = createRagStoreFromEnv(env);
  const scopeExpansionCap = parseScopeExpansionCap(env["SCOPE_EXPANSION_CAP"]);
  const neighbourRadius = parseNeighbourRadius(env["NEIGHBOUR_EXPANSION_RADIUS"]);
  const neighbourCap = parseNeighbourCap(env["NEIGHBOUR_EXPANSION_CAP"]);
  return {
    pipeline: {
      routerProvider: providers.router,
      generatorProvider: providers.generator,
      reviewerProvider: providers.reviewer,
      reviewerDecider: providers.decider,
      embedder: providers.embedder,
      // The retrieval stage's embed call is the one provider call with no event
      // of its own: the retriever hands this collector the run's trace sink, so
      // the CostRecord (model, tokens, latency, µUSD, estimate flag) becomes a
      // retriever-stage `llm_call` on the answer's trace. Without it the trace
      // sums short of the run's provider calls and the Trace panel cannot name
      // the embedder.
      onCost: (cost, sink) =>
        sink.record({
          stage: "retriever",
          kind: "llm_call",
          detail: { purpose: "embed" },
          cost,
          at: sink.now(),
        }),
      store,
      bridge: storeBridge(store),
      // Absent = the domain default: the per-query expansion budget is a
      // deployment choice, not a code literal.
      ...(scopeExpansionCap !== undefined ? { scopeExpansionCap } : {}),
      // The same posture for the retrieved-verse neighbourhood window: `0` on
      // either knob turns it off, and a negative value never reaches this object
      // because the parsers above reject it as a typed config failure.
      ...(neighbourRadius !== undefined ? { neighbourRadius } : {}),
      ...(neighbourCap !== undefined ? { neighbourCap } : {}),
    },
    fullStore: store,
    runStore: storeBridge(store),
  };
}

/**
 * The one place the wiring-to-503 posture lives: a typed `ChatConfigError` means
 * "not configured in this environment" and becomes a 503 with the route's own error
 * code; anything else rethrows to the app's typed error handler with its cause logged.
 */
export function wiringOr503<W>(
  build: () => W,
  logger: Logger,
  errorCode: string,
): { wiring: W } | { response: Response } {
  try {
    return { wiring: build() };
  } catch (err) {
    if (err instanceof ChatConfigError) {
      logger.warn("wiring.not_configured", { errorCode, missing: err.missing ?? "unknown" });
      return { response: Response.json({ error: errorCode }, { status: 503 }) };
    }
    throw err;
  }
}

/**
 * The SSE frame wire format the eval harness consumes (meta/delta/done).
 *
 * Multi-line data MUST be emitted as one `data:` line per line: a raw newline inside
 * a `data:` payload produces a blank line, which terminates the frame and drops the
 * remainder — the path an appended rule hits, so this is load-bearing.
 */
export function sseFrame(event: string, data: string): string {
  const lines = data.split("\n").map((line) => `data: ${line}`);
  return `event: ${event}\n${lines.join("\n")}\n\n`;
}
