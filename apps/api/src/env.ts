import type { Logger, RagStore } from "@app/infra";
import type { RateLimiter } from "./lib/rate-limit-mw";
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
  ALLOWED_ORIGINS?: string;
  SENTRY_DSN?: string;
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

export type { RateLimiter } from "./lib/rate-limit-mw";

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
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
