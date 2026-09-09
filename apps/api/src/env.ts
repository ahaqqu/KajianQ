import type { Logger, RagStore } from "@app/infra";
import type { RateLimiterNamespace } from "@app/rate";
import type { R2Bucket } from "./cf-types";

export type AppEnvName = "development" | "staging" | "production";

/** Per-request context built once in middleware and threaded through `c.var`. */
export type RequestContext = {
  logger: Logger;
  envName: AppEnvName;
  correlationId: string;
};

export type WorkerBindings = {
  ASSETS: { fetch: typeof fetch };
  APP_ENV?: string;
  BUCKET?: R2Bucket;
  RATE_LIMITER?: RateLimiterNamespace;
  ALLOWED_ORIGINS?: string;
  SENTRY_DSN?: string;
  /** Neon connection string — the RagStore adapter's backing store (#4). */
  DATABASE_URL?: string;
  /**
   * Provider API keys, bound by name from `models.json`'s `apiKeyEnv`
   * entries (ADR-0009/ADR-0022). The wiring reads keys only through
   * `resolveRole`'s env record — never vendor names here.
   */
  GEMINI_API_KEY?: string;
  DASHSCOPE_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  MOONSHOT_API_KEY?: string;
};

/**
 * Resolved per-request identity, set by `authGuard` before guarded routes run.
 * Session persistence lives behind the RagStore seam (ADR-0008); the store is
 * now a concrete `RagStore` rather than a placeholder, but guarded routes stay
 * unmounted in this foundation shell until #4 lands the Neon adapter wiring.
 */
export type Authed = { store: RagStore; userId: string };

/** Hono generics for the whole API: bindings + request-scoped variables. */
export type ApiEnv = {
  Bindings: WorkerBindings;
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
