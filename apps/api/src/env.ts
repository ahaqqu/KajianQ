import type { RagStore } from "@app/infra";
import type { R2Bucket } from "./cf-types";

export type AppEnvName = "development" | "staging" | "production";

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
  Variables: { correlationId: string; authed: Authed };
};

export type { R2Bucket };

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
