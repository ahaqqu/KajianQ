import type { D1Database, R2Bucket } from "./cf-types";

export type AppEnvName = "development" | "staging" | "production";

export type WorkerBindings = {
  ASSETS: { fetch: typeof fetch };
  APP_ENV?: string;
  DB?: D1Database;
  BUCKET?: R2Bucket;
  ALLOWED_ORIGINS?: string;
  SENTRY_DSN?: string;
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
    return ["http://localhost:8787", "http://127.0.0.1:8787"];
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
