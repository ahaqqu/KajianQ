import * as neon from "@neondatabase/serverless";
import { Effect } from "effect";
import { createRagStore, loadProviderConfig, resolveRole, type RagStore } from "@app/infra";
export { authGuard } from "./auth";

/**
 * Env-bound wiring for the chat route (#8): the one place the Worker's
 * bindings become seams. Route handlers read `RagStore`/`Provider` — never
 * `env.*` (dars-pluggability: business logic accesses adapters through the
 * interface). This module is also the ONLY place in the API that imports the
 * effect runtime directly (it owns the store-seam bridge, mirroring the
 * composition-root exception ADR-0027 grants the wiring layer).
 */

/**
 * Build the RagStore from the `DATABASE_URL` binding. Throws (config-class)
 * when the binding is missing — the route answers 503 rather than silently
 * degrading.
 */
export function createRagStoreFromEnv(env: { DATABASE_URL?: string }): RagStore {
  const url = env.DATABASE_URL;
  if (!url || url.trim() === "") {
    throw new Error("chat route: DATABASE_URL is not bound");
  }
  const sql = neon.neon(url);
  return createRagStore("neon", sql);
}

/** The provider roles the chat pipeline needs, resolved once per request. */
export type ChatProviders = {
  router: ReturnType<typeof resolveRole>["provider"];
  generator: ReturnType<typeof resolveRole>["provider"];
  reviewer: ReturnType<typeof resolveRole>["provider"] | null;
  embedder: ReturnType<typeof resolveRole>["provider"];
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
 * Resolve the chat pipeline's provider roles from the checked-in config and
 * the Worker bindings. Roles without any keyed candidate resolve to a
 * Provider whose calls fail with a clear error — wiring never branches on
 * key presence.
 */
export function createProvidersFromEnv(env: Record<string, string | undefined>): ChatProviders {
  const config = loadProviderConfig();
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
  return (effect) => Effect.runPromise(effect as Effect.Effect<never, never>);
}

/** The wiring bundle a chat request needs (built per request from bindings). */
export type ChatWiring = {
  pipeline: Omit<import("@app/kajianq-domain").ChatPipelineDeps, "language">;
  fullStore: RagStore;
  runStore: (effect: unknown) => Promise<unknown>;
};

/**
 * Build the chat wiring from the Worker bindings (providers + store + the
 * store bridge). Throws (config-class) when the store is not configured; the
 * route maps that to 503.
 */
export function buildChatWiring(env: Record<string, string | undefined>): ChatWiring {
  const store = createRagStoreFromEnv(env);
  const providers = createProvidersFromEnv(env);
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

/** The SSE frame wire format the eval harness consumes (meta/delta/done). */
export function sseFrame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}
