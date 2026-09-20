import { createLogger } from "@app/infra";
import type { Hono } from "hono";
import type { ApiEnv, AppBindings } from "../env";
import { createDiskAssetFetcher } from "./assets";

/**
 * The Bun serving entry (#181, ADR-0044): bind the Hono app to a TCP socket
 * and start a plain Bun server behind the VPS reverse proxy. This replaced
 * Cloudflare's `export default { fetch, scheduled }` handler entirely — the
 * app itself (`createApi`) and the middleware stack are unchanged, so the
 * serving path stays one composition of the same Hono routes.
 *
 * Configuration comes from the environment, read ONCE here at the composition
 * root — the app's business logic never touches `env.*` (AGENTS.md). The
 * systemd unit supplies the values through `EnvironmentFile=/etc/kajianq/api.env`.
 */

/**
 * Copy every present (non-empty) key from the environment onto the bindings.
 * Keys are copied rather than listed so adding a provider key to `models.json`
 * does not silently require an edit here; an absent key stays absent, which is
 * the "feature disabled" posture the wiring already implements (a role with no
 * keyed candidate resolves to a provider that fails with a clear error).
 */
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
  "MOONSHOT_API_KEY",
] as const;

/** Read the process environment into the app's binding shape. */
export function bindingsFromEnv(env: Record<string, string | undefined>): AppBindings {
  return {
    ASSETS: createDiskAssetFetcher(env.KAJIANQ_WEB_ROOT ?? "./apps/web/dist"),
    ...present(env, PASSTHROUGH_KEYS),
  };
}

export type ServeOptions = {
  /** The app to serve; defaults to a fresh `createApi()`. */
  api: Hono<ApiEnv>;
  /** Host to bind; defaults to a loopback address (the proxy is the only ingress). */
  hostname?: string;
  /** Port to bind; defaults to `PORT` or 8787. */
  port?: number;
  /** The environment record; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
};

/**
 * Start the Bun server. The bind address defaults to loopback: the design is
 * a reverse proxy (nginx) as the only public ingress, so the API must not be
 * reachable directly. Binding elsewhere is possible for a container, but is
 * never the default.
 *
 * The anonymous-session reclamation (ADR-0017) is NOT run in-process: it is a
 * systemd timer running a second, dedicated entry (`src/cleanup.ts`), so it
 * stays independently observable with `systemctl status kajianq-cron` and does
 * not depend on the serving process being healthy to reclaim. One job, one
 * schedule, one mechanism.
 */
export function serveApi(opts: ServeOptions): { stop: () => Promise<void> } {
  const env = opts.env ?? process.env;
  const bindings = bindingsFromEnv(env);
  const hostname = opts.hostname ?? env.KAJIANQ_API_HOST ?? "127.0.0.1";
  const port = opts.port ?? Number(env.PORT ?? "8787");

  const server = Bun.serve({
    hostname,
    port,
    fetch: (request) => opts.api.fetch(request, bindings, undefined as never),
  });

  const logger = createLogger({ service: "api", route: "bootstrap" });
  logger.info("server.listening", { hostname, port });

  const stop = async (): Promise<void> => {
    await server.stop();
  };
  return { stop };
}
