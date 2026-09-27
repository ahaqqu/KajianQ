import type { AssetFetcher } from "@app/hardening";
import type { Logger, RagStore } from "@app/infra";

export type AppEnvName = "development" | "staging" | "production";

/** Per-request context built once in middleware and threaded through `c.var`. */
export type RequestContext = {
  logger: Logger;
  envName: AppEnvName;
  correlationId: string;
};

/**
 * The environment the Hono app is handed once per request (#181, ADR-0044).
 *
 * On Cloudflare this was the Worker's binding object, injected by the runtime.
 * Self-hosted, the Bun serving entry builds it from `process.env` at the
 * composition root (`lib/server.ts`) and the reverse proxy is the only
 * ingress — so the shape is now plain configuration: the database URL, the
 * allowed origins, Sentry, and the provider keys. Nothing host-specific
 * remains (no Durable Object, no R2 binding): the rate limiter is the
 * package's process-global in-memory backend, and raw-corpus archival is a
 * CLI concern, never a serving path.
 */
export type AppBindings = {
  ASSETS: AssetFetcher;
  APP_ENV?: string;
  /** Postgres connection string — the RagStore adapter's backing store (#4). */
  DATABASE_URL?: string;
  ALLOWED_ORIGINS?: string;
  SENTRY_DSN?: string;
  /**
   * Provider API keys, bound by name from `models.json`'s `apiKeyEnv`
   * entries (ADR-0009/ADR-0022). The wiring reads keys only through
   * `resolveRole`'s env record — never vendor names here.
   */
  GEMINI_API_KEY?: string;
  /** Paid-terms Gemini row (same API, billing-enabled project — #181). */
  GEMINI_PAID_API_KEY?: string;
  DASHSCOPE_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  /**
   * The decision vendor's key (#168): binds the reviewer pre-gate. Optional —
   * an absent key leaves the reviewer exactly as it was before adoption,
   * because the pre-gate only ever removes spend (fail-open).
   */
  JEV_API_KEY?: string;
  /**
   * ADR-0045's surah-reference scope-expansion budget, as a non-negative
   * integer string. Absent = the domain default (`DEFAULT_SCOPE_EXPANSION_CAP`);
   * `0` disables the expansion. Config, never a secret, but it rides the same
   * filtered env view so the knob reaches the pipeline's wiring.
   */
  SCOPE_EXPANSION_CAP?: string;
};

/**
 * Resolved per-request identity, set by `authGuard` before guarded routes run.
 * Session persistence lives behind the RagStore seam (ADR-0008); the store is
 * a concrete `RagStore` rather than a placeholder.
 */
export type Authed = { store: RagStore; userId: string };

/** Hono generics for the whole API: bindings + request-scoped variables. */
export type ApiEnv = {
  Bindings: AppBindings;
  Variables: { correlationId: string; ctx: RequestContext; authed: Authed };
};

export type { RateLimiter } from "@app/rate";

export function resolveEnvName(raw: string | undefined): AppEnvName {
  if (raw === "staging" || raw === "production" || raw === "development") {
    return raw;
  }
  return "development";
}

export function allowedOrigins(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
