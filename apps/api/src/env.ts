import type { D1Database, R2Bucket, RateLimiterNamespace } from "./cf-types";

export type AppEnvName = "development" | "staging" | "production";

export type WorkerBindings = {
  ASSETS: { fetch: typeof fetch };
  APP_ENV?: string;
  DB?: D1Database;
  BUCKET?: R2Bucket;
  RATE_LIMITER?: RateLimiterNamespace;
  ALLOWED_ORIGINS?: string;
  SENTRY_DSN?: string;
};

/** Resolved per-request identity, set by `authGuard` before guarded routes run. */
export type Authed = { db: D1Database; userId: string };

/** Hono generics for the whole API: bindings + request-scoped variables. */
export type ApiEnv = {
  Bindings: WorkerBindings;
  Variables: { correlationId: string; authed: Authed };
};

export type { D1Database, R2Bucket };

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
