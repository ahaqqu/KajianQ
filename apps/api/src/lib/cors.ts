import { cors } from "hono/cors";
import type { Context, Next } from "hono";
import { allowedOrigins, type ApiEnv } from "../env";

/**
 * Pure CORS origin resolution, extracted from the old inline app.ts callback.
 * Returns the value for Access-Control-Allow-Origin:
 * - no Origin header (same-origin navigations) → first allowlisted origin, or "*"
 * - allowlisted origin → echo it
 * - worker's own host (SPA + API same origin) → echo it
 * - anything else → "" (browser blocks)
 */
export function resolveCorsOrigin(
  origin: string | undefined,
  requestUrl: string,
  allowlist: string[],
): string {
  if (!origin) return allowlist[0] ?? "*";
  if (allowlist.includes(origin)) return origin;
  try {
    if (origin === new URL(requestUrl).origin) return origin;
  } catch {
    /* ignore */
  }
  return "";
}

/** CORS middleware; allowlist comes from env per request. */
export function corsGuard(c: Context<ApiEnv>, next: Next) {
  const origins = allowedOrigins(c.env.ALLOWED_ORIGINS);
  return cors({
    origin: (origin) => resolveCorsOrigin(origin, c.req.url, origins),
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Correlation-Id"],
  })(c, next);
}
