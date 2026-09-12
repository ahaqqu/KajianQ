import * as neon from "@neondatabase/serverless";
import { runStoreEffect } from "@app/kajianq-domain";
import type { Provider } from "@app/rag-core";
import {
  createRagStore,
  loadProviderConfig,
  resolveRole,
  type Logger,
  type ProviderConfig,
  type RagStore,
} from "@app/infra";
export { authGuard } from "./auth";
// Re-exported so the chat route keeps its 5-import agentic cap (same pattern
// as the authGuard re-export): the route imports one name from its lib hub.
export { citationsFrameFor, chunkFetcher, rehydrateTranscript } from "./chat-citations";

/**
 * Env-bound wiring for the chat route (#10): the one place the Worker's
 * bindings become seams. Route handlers read `RagStore`/`Provider` — never
 * `env.*` (dars-pluggability: business logic accesses adapters through the
 * interface). This module is also the ONLY place in the API that imports the
 * effect runtime directly (it owns the store-seam bridge, mirroring the
 * composition-root exception ADR-0027 grants the wiring layer).
 */

/**
 * A misconfigured chat wiring (thermo-review A7): typed so the route maps
 * configuration failures to 503 while anything else falls through to the
 * app's typed error handler — a bare `Error` + catch-all 503 used to mask
 * adapter bugs as "not configured".
 */
export class ChatConfigError extends Error {
  readonly missing?: string;
  constructor(msg: string, missing?: string) {
    super(msg);
    this.name = "ChatConfigError";
    if (missing !== undefined) this.missing = missing;
  }
}

/**
 * Build the RagStore from the `DATABASE_URL` binding. Throws a typed
 * `ChatConfigError` (config-class) when the binding is missing — the route
 * answers 503 rather than silently degrading; anything else propagates to
 * the typed error handler.
 */
export function createRagStoreFromEnv(env: { DATABASE_URL?: string }): RagStore {
  const url = env.DATABASE_URL;
  if (!url || url.trim() === "") {
    throw new ChatConfigError("chat route: DATABASE_URL is not bound", "DATABASE_URL");
  }
  const sql = neon.neon(url);
  return createRagStore("neon", sql);
}

/** The provider roles the chat pipeline needs, resolved once per request. */
export type ChatProviders = {
  router: Provider;
  generator: Provider;
  reviewer: Provider | null;
  embedder: Provider;
  /** Env names whose keys were absent (ops visibility, never client-facing). */
  missingKeys: readonly string[];
};

/** True when the role has at least one keyed candidate. */
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
 * The checked-in provider config is import-bounded and immutable at runtime
 * (thermo-review B7): parse and validate it once at module load; the
 * per-request path only resolves roles against the cached config.
 */
const CACHED_PROVIDER_CONFIG: ProviderConfig = loadProviderConfig();

/**
 * Resolve the chat pipeline's provider roles from the checked-in config and
 * the Worker bindings. Roles without any keyed candidate resolve to a
 * Provider whose calls fail with a clear error — wiring never branches on
 * key presence.
 *
 * The reviewer is the one role whose absence is a *configuration* failure,
 * not a degradation: it carries the cross-vendor faithfulness check, and the
 * chat path must not silently serve unreviewed answers (ticket #10 — the
 * reviewer is non-optional for the chat path). `buildChatWiring` raises a
 * typed `ChatConfigError` when no reviewer candidate is keyed, so the route
 * answers 503 instead of quietly dropping the check.
 */
export function createProvidersFromEnv(env: Record<string, string | undefined>): ChatProviders {
  const config = CACHED_PROVIDER_CONFIG;
  const missing = new Set<string>();
  const resolve = (role: string) => {
    const { provider, missingKeys } = resolveRole(config, role, { env });
    for (const key of missingKeys) missing.add(key);
    return provider;
  };
  return {
    router: resolve("cheap"),
    generator: resolve("generator"),
    reviewer: roleHasKey(config, env, "reviewer") ? resolve("reviewer") : null,
    embedder: resolve("embedder"),
    missingKeys: [...missing],
  };
}

/**
 * The store-seam bridge: run one Effect-signatured store call to a promise.
 * Lives in the wiring (not route handlers) so the handlers hold plain
 * promise-shaped helpers only.
 */
export function storeBridge(_store: RagStore): (effect: unknown) => Promise<unknown> {
  return (effect) => runStoreEffect(effect);
}

/** The wiring bundle a chat request needs (built per request from bindings). */
export type ChatWiring = {
  pipeline: Omit<
    import("@app/kajianq-domain").ChatPipelineDeps,
    "language" | "history" | "onDelta"
  >;
  fullStore: RagStore;
  runStore: (effect: unknown) => Promise<unknown>;
};

/**
 * The store-only wiring the auth routes need (thermo-review A4): a store plus
 * its bridge, with no provider roles resolved at all.
 *
 * Auth is not the chat pipeline. Session minting and anonymous self-deletion
 * (ADR-0017's erasure right) must not be gated on an unrelated LLM role: a
 * rotated reviewer key would otherwise take down token minting and erasure —
 * and with it the eval harness's token mint. The reviewer-mandatory check
 * stays on `buildChatWiring`, where the chat pipeline's config contract lives.
 */
export type StoreWiring = {
  fullStore: RagStore;
  runStore: (effect: unknown) => Promise<unknown>;
};

export function buildStoreWiring(env: { DATABASE_URL?: string }): StoreWiring {
  const store = createRagStoreFromEnv(env);
  return { fullStore: store, runStore: storeBridge(store) };
}

/**
 * Build the chat wiring from the Worker bindings (providers + store + the
 * store bridge). Throws (config-class) when the store is not configured or
 * when the reviewer role has no keyed candidate — the route maps both to 503.
 */
export function buildChatWiring(env: Record<string, string | undefined>): ChatWiring {
  const providers = createProvidersFromEnv(env);
  if (providers.reviewer === null) {
    // Non-optional for the chat path: an unreviewed answer is not a lesser
    // answer, it is an unverified one. Fail closed. Checked before the store
    // is constructed so the config error is reported as a config error rather
    // than a store-construction failure.
    throw new ChatConfigError(
      "chat route: reviewer role has no keyed candidate — the cross-vendor faithfulness check is mandatory",
      providers.missingKeys.join(", ") || "reviewer",
    );
  }
  const store = createRagStoreFromEnv(env);
  return {
    pipeline: {
      routerProvider: providers.router,
      generatorProvider: providers.generator,
      reviewerProvider: providers.reviewer,
      embedder: providers.embedder,
      store,
      bridge: storeBridge(
        store,
      ) as unknown as import("@app/kajianq-domain").ChatPipelineDeps["bridge"],
    },
    fullStore: store,
    runStore: storeBridge(store),
  };
}

/**
 * The one place the wiring-to-503 posture lives (thermo-review B1): a typed
 * `ChatConfigError` means "this route is not configured in this environment"
 * and becomes a 503 with the route's own error code; anything else is a real
 * fault and rethrows to the app's typed error handler with its cause logged.
 * Three routes previously carried near-identical copies of this block, so a
 * policy change had to be applied in three places.
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
 * Multi-line data MUST be emitted as one `data:` line per line (the SSE spec):
 * a raw newline inside a single `data:` payload produces a blank line, which
 * terminates the frame — the remainder then arrives as a frame with no
 * `data:` field and is dropped by a spec-following client. An answer that
 * appends a rule after a blank line (the disclaimer, the dhaif warning) hits
 * exactly that path, so the escaping is load-bearing, not cosmetic.
 */
export function sseFrame(event: string, data: string): string {
  const lines = data.split("\n").map((line) => `data: ${line}`);
  return `event: ${event}\n${lines.join("\n")}\n\n`;
}
