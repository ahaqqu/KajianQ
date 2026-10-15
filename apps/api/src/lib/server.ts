import { createLogger, type Logger } from "@app/infra";
import type { Hono } from "hono";
import type { ApiEnv, AppBindings } from "../env";
import { createDiskAssetFetcher } from "./assets";
import { createProvidersFromEnv, type ChatProviders } from "./chat-wiring";

/**
 * The Bun serving entry: bind the Hono app to a TCP socket behind the reverse
 * proxy. Configuration is read ONCE here at the composition root; business logic
 * never touches `env.*`.
 */

/** Copy every present (non-empty) key onto the bindings. Keys are copied rather
 * than listed so a new provider key needs no edit here; an absent key stays
 * absent — the wiring's "feature disabled" posture. */
function present(env: Record<string, string | undefined>, keys: readonly string[]) {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

const PASSTHROUGH_KEYS = [
  "APP_ENV",
  "DATABASE_URL",
  "ALLOWED_ORIGINS",
  "SENTRY_DSN",
  "GEMINI_API_KEY",
  "GEMINI_PAID_API_KEY",
  "DASHSCOPE_API_KEY",
  "DEEPSEEK_API_KEY",
  // Optional (never a boot precondition), but it MUST be passed through: a key
  // dropped here leaves the reviewer pre-gate silently dead in serving.
  "JEV_API_KEY",
  // Optional config (absent = the domain default) that must ride this filtered
  // view or the knob is dead in serving.
  "SCOPE_EXPANSION_CAP",
  // Same contract as the scope cap, for the two neighbourhood knobs.
  "NEIGHBOUR_EXPANSION_RADIUS",
  "NEIGHBOUR_EXPANSION_CAP",
] as const;

/** The filtered env view requests receive: every present (non-empty) `PASSTHROUGH_KEYS`
 * entry, nothing else. Built ONCE per boot and shared by the request bindings and the
 * posture report, so the report cannot drift from what serving wires. */
function chatEnvFrom(env: Record<string, string | undefined>): Record<string, string> {
  return present(env, PASSTHROUGH_KEYS);
}

/** Build the bindings from that one filtered view; `KAJIANQ_WEB_ROOT` is read
 * from the raw env, since it configures the asset handler and is not a chat key. */
function bindingsFrom(
  env: Record<string, string | undefined>,
  chatEnv: Record<string, string>,
): AppBindings {
  return {
    ASSETS: createDiskAssetFetcher(env.KAJIANQ_WEB_ROOT ?? "./apps/web/dist"),
    ...chatEnv,
  };
}

export function bindingsFromEnv(env: Record<string, string | undefined>): AppBindings {
  return bindingsFrom(env, chatEnvFrom(env));
}

export type ServeOptions = {
  api: Hono<ApiEnv>;
  hostname?: string;
  port?: number;
  env?: Record<string, string | undefined>;
};

/**
 * The SIGTERM drain window, in milliseconds: the bound a restart waits for
 * in-flight answers before closing them anyway. It must match the proxy's read
 * timeout and systemd's `TimeoutStopSec` (both 300 s), since agreeing numbers are
 * what make the drain deterministic. Hitting the deadline closes in-flight
 * streams deliberately: a cut-off answer beats a wedged restart.
 */
export const DRAIN_TIMEOUT_MS = 300_000;

/**
 * Emit the provider posture ONCE at startup: which env vars the chat path found
 * absent — including the optional decision role's — and which decision candidate
 * the personal-data posture dropped. **Names only, never values**: resolve
 * `providers` through the same `createProvidersFromEnv` the request path uses,
 * from the boot's one filtered chat env view (`chatEnvFrom`), so the report
 * cannot drift from what serving wires.
 */
export function reportProviderPosture(providers: ChatProviders, logger: Logger): void {
  logger.info("providers.posture", {
    reviewer: providers.reviewer === null ? "not_wired" : "wired",
    preGate: providers.decider === null ? "not_wired" : "active",
    missingKeys: providers.missingKeys.join(", ") || "none",
    ineligibleKeys: providers.ineligibleKeys.join(", ") || "none",
  });
}

/**
 * Start the Bun server. The bind address defaults to loopback: a reverse proxy is
 * the only public ingress, so the API must not be reachable directly.
 *
 * Anonymous-session reclamation is NOT run in-process: a systemd timer runs a
 * dedicated entry (`src/cleanup.ts`), so reclaiming stays observable
 * independently of the serving process's health.
 */
export function serveApi(opts: ServeOptions): { stop: () => Promise<void> } {
  const env = opts.env ?? process.env;
  // The one filtered view this boot builds, shared by the bindings and the report.
  const chatEnv = chatEnvFrom(env);
  const bindings = bindingsFrom(env, chatEnv);
  const hostname = opts.hostname ?? env.KAJIANQ_API_HOST ?? "127.0.0.1";
  const port = opts.port ?? Number(env.PORT ?? "8787");

  const server = Bun.serve({
    hostname,
    port,
    fetch: (request) => opts.api.fetch(request, bindings, undefined as never),
  });

  const logger = createLogger({ service: "api", route: "bootstrap" });
  // Runs outside the request path's `wiringOr503`: a config fault fails the boot
  // just after `Bun.serve` binds (systemd restarts the unit), never a silent
  // per-request default.
  reportProviderPosture(createProvidersFromEnv(chatEnv), logger);
  logger.info("server.listening", { hostname, port });

  const stop = async (): Promise<void> => {
    // `server.stop()` waits for in-flight requests but has no ceiling of its own
    // — this deadline is the bound. A stream past it is closed deliberately: the
    // alternative is a restart hanging until the unit's TimeoutStopSec SIGKILLs us.
    let fire: (() => void) | undefined;
    const deadline = new Promise<void>((resolve) => {
      fire = resolve;
    });
    const timer = setTimeout(fire ?? (() => {}), DRAIN_TIMEOUT_MS);
    timer.unref();
    try {
      await Promise.race([server.stop(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
  return { stop };
}
