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
  parseCallerPriorityK,
  parseChainEvidenceChainCap,
  parseChainEvidenceChildCap,
  parseLabelLookupCap,
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
  parseCallerPriorityK,
  parseChainEvidenceChainCap,
  parseChainEvidenceChildCap,
  parseLabelLookupCap,
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
  /** The decision-model serving role — the reviewer's citation pre-gate and the
   * retrieval rerank share it; null when no decision candidate is keyed. Bound
   * key = active, with no enable flag. */
  decider: Decider | null;
  embedder: Provider;
  missingKeys: readonly string[];
  /** Decision candidates the personal-data posture excluded: a vendor that forbids
   * personal data may never carry the pre-gate's claim spans or the rerank's
   * question, and the filter runs before the key check, so an unkeyed candidate
   * lands here too. */
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
  // The config is a parameter (defaulting to the checked-in config with this
  // env's `PROVIDER_PROFILE` applied) so resolution stays a pure function of
  // (config, env), drivable by a synthetic vendor set. An unknown profile
  // throws a typed `ProviderConfigError` here at wiring time — never a silent
  // fall back to the default chains.
  config: ProviderConfig = loadProviderConfig(env.PROVIDER_PROFILE),
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
 * `T` with every key `Shape` does not declare turned into `never`: the exactness check an
 * object literal's excess-property check does not give once a spread introduces the key.
 */
type NoExtraKeys<T, Shape> = T & Record<Exclude<keyof T, keyof Shape>, never>;

/**
 * The retriever knobs serving must state. `Required` drops each optionality while keeping
 * `| undefined` — a stated value meaning the retriever's own default — so every knob the
 * deps carry, and any the retriever gains, is a compile error here when dropped by leaving
 * the key out, while a box that binds none of them still runs the defaults.
 */
type ServingRetrieval = Required<ChatWiring["pipeline"]["retrieval"]>;

/** The serving retrieval bag, exact: a key `ServingRetrieval` does not declare, including
 * one a spread smuggles in, must not compile beside a bag no stage reads. */
function servingRetrieval<T extends ServingRetrieval>(
  bag: NoExtraKeys<T, ServingRetrieval>,
): ServingRetrieval {
  return bag;
}

/** The pipeline bag, exact for the same reason: a key the pipeline deps do not declare must
 * not arrive through a spread and sit there configured-looking and unread. */
function pipelineBag<T extends ChatWiring["pipeline"]>(
  deps: NoExtraKeys<T, ChatWiring["pipeline"]>,
): ChatWiring["pipeline"] {
  return deps;
}

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
  // Every retriever knob, stated at once: `undefined` is the retriever's own default, so a
  // box that binds none of them behaves as it always did, while `0` is a real value (it
  // disables its arm) and a negative or malformed value never reaches the deps — the
  // parsers raise a typed config failure instead.
  const retrieval = servingRetrieval({
    // The deps type carries `limit`, but serving binds no variable to it: stating
    // `undefined` keeps the bag exact — every knob is stated, and an absent binding is the
    // retriever's own default rather than a key the composition root forgot.
    limit: undefined,
    scopeExpansionCap: parseScopeExpansionCap(env["SCOPE_EXPANSION_CAP"]),
    neighbourRadius: parseNeighbourRadius(env["NEIGHBOUR_EXPANSION_RADIUS"]),
    neighbourCap: parseNeighbourCap(env["NEIGHBOUR_EXPANSION_CAP"]),
    labelLookupCap: parseLabelLookupCap(env["LABEL_LOOKUP_CAP"]),
    callerPriorityK: parseCallerPriorityK(env["CALLER_PRIORITY_K"]),
    chainEvidenceChildCap: parseChainEvidenceChildCap(env["CHAIN_EVIDENCE_CHILD_CAP"]),
    chainEvidenceChainCap: parseChainEvidenceChainCap(env["CHAIN_EVIDENCE_CHAIN_CAP"]),
  });
  return {
    pipeline: pipelineBag({
      routerProvider: providers.router,
      generatorProvider: providers.generator,
      reviewerProvider: providers.reviewer,
      reviewerDecider: providers.decider,
      // One serving role, two adoptions: the retrieval rerank consumes the same
      // keyed decider as the reviewer pre-gate (ADR-0042).
      rerankDecider: providers.decider,
      embedder: providers.embedder,
      store,
      bridge: storeBridge(store),
      retrieval,
    }),
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
