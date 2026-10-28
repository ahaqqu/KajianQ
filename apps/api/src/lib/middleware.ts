import {
  allowRequest,
  corsGuard,
  createRequestContext,
  fnv1aHex,
  installSecurityHeaders,
  resolveRateLimiter,
} from "./";
import { checkBypassHeader, RATE_BYPASS_HEADER } from "./rate-bypass";
import type { ApiEnv, RateLimiter } from "../env";
import { trimTrailingSlash } from "hono/trailing-slash";
import type { Hono } from "hono";

export type MiddlewareOpts = {
  limiter?: RateLimiter;
  limit?: number;
  /** The login POST's budget, per IP per minute (ADR-0064). Default 5. */
  adminLoginLimit?: number;
  /** The admin read surface's budget, per IP per minute (ADR-0064). Default 60. */
  adminLimit?: number;
  /** Verifier key for bypass tokens; tests inject a generated keypair's key. */
  bypassPublicKeyB64?: string;
};

/** The login POST's default budget: tight enough that guessing a credential is
 * hopeless, loose enough that a mistyped password does not lock the operator out. */
export const ADMIN_LOGIN_LIMIT = 5;

/** The admin reads' default budget: a browsing operator pages through traces far
 * below this, while a scripted harvest is throttled. */
export const ADMIN_READ_LIMIT = 60;

/** Installs the cross-cutting middleware every route shares. */
export function applyMiddleware(api: Hono<ApiEnv>, opts?: MiddlewareOpts): void {
  api.use("*", trimTrailingSlash());
  installSecurityHeaders(api);
  api.use("*", corsGuard);
  api.use("*", async (c, next) => {
    const id = c.req.header("X-Correlation-Id") ?? crypto.randomUUID();
    const ctx = createRequestContext(c.env.APP_ENV, id);
    c.set("correlationId", id);
    c.set("ctx", ctx);
    c.header("X-Correlation-Id", id);
    await next();
  });
  // Rate limiting is an API-surface policy (ADR-0041): only /v1/* is metered.
  // Static assets and the doc routes flow through unmetered — asset fetches
  // cannot carry credentials, and metering them steals the per-IP budget from
  // real chat calls.
  api.use("/v1/*", async (c, next) => {
    // A valid bypass token (Ed25519 JWT, ADR-0041) exempts the request from
    // metering — harness traffic (DAST/load tests), never user sessions: the
    // token grants nothing else. An invalid or absent token degrades to
    // ordinary metering; the reason is logged, never leaked to the response.
    const bypass = await checkBypassHeader(c.req.header(RATE_BYPASS_HEADER), opts);
    const ctx = c.get("ctx");
    if (bypass.ok) {
      ctx.logger.debug("rate.bypass", { subject: bypass.subject, path: c.req.path });
      return next();
    }
    if (bypass.reason !== "absent") {
      ctx.logger.warn("rate.bypass_rejected", { reason: bypass.reason });
    }
    // The client IP is proxy-established: nginx overwrites CF-Connecting-IP
    // from $remote_addr (provision/vps/nginx/kajianq.conf), so a client-set
    // value cannot influence the limiter. It is digested before it names a
    // counter (fnv1aHex) so the limiter holds no raw address — the retention
    // notice's "kept in memory and named by a digest" claim (ADR-0043 d4).
    const ip = c.req.header("CF-Connecting-IP") ?? "local";
    const limiter = opts?.limiter ?? resolveRateLimiter();
    if (!(await allowRequest(`ip:${fnv1aHex(ip)}`, limiter, opts?.limit))) {
      return c.json({ error: "rate_limited" }, 429);
    }
    await next();
  });
  // The admin surface has its own budget (ADR-0064), in namespaces of its own: the
  // login POST — the only unauthenticated write on the API — gets a tight one, and
  // the reads get the browsing one. It is NOT metered by the public `/v1` meter,
  // whose budget protects the chat's spend; sharing that namespace would let either
  // surface exhaust the other. The client IP is digested before it names a counter,
  // exactly as on the public path, so no raw address is held here either.
  api.use("/admin/*", async (c, next) => {
    const login = c.req.method === "POST" && c.req.path === "/admin/v1/session";
    const limit = login
      ? (opts?.adminLoginLimit ?? ADMIN_LOGIN_LIMIT)
      : (opts?.adminLimit ?? ADMIN_READ_LIMIT);
    const ip = c.req.header("CF-Connecting-IP") ?? "local";
    const limiter = opts?.limiter ?? resolveRateLimiter();
    const allowed = await allowRequest(
      `${login ? "admin-login" : "admin-read"}:${fnv1aHex(ip)}`,
      limiter,
      limit,
    );
    if (!allowed) return c.json({ error: "rate_limited" }, 429);
    await next();
  });
}
