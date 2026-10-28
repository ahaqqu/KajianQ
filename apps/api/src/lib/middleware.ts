import {
  ADMIN_API_PREFIX,
  ADMIN_LOGIN_PATH,
  allowRequest,
  corsGuard,
  createRequestContext,
  fnv1aHex,
  installSecurityHeaders,
  isAdminApiPath,
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
  // Rate limiting is an API-surface policy (ADR-0041): the public `/v1/*` surface is
  // metered, while the admin namespace under it has meters of its own (below) — a
  // path test, not a separate top-level prefix, keeps the two budgets disjoint.
  // Static assets and the doc routes flow through unmetered — asset fetches
  // cannot carry credentials, and metering them steals the per-IP budget from
  // real chat calls.
  api.use("/v1/*", async (c, next) => {
    // The admin surface is not public: it must neither spend nor be throttled by the
    // chat meter. The admin middleware below bills its own namespaces.
    if (isAdminApiPath(c.req.path)) return next();
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
  // login POST — the admin surface's only unauthenticated write — gets a tight one,
  // and the reads get the browsing one. Sharing the public `/v1` namespace would let
  // either surface exhaust the other. The client IP is digested before it names a
  // counter, exactly as on the public path, so no raw address is held here either.
  // Every answer from this namespace, refusals included, is `no-store`: a 400/404/422/
  // 503 is a per-request verdict, and a cached one would outlive the condition it
  // reported.
  api.use(`${ADMIN_API_PREFIX}/*`, async (c, next) => {
    c.header("Cache-Control", "no-store");
    const login = c.req.method === "POST" && c.req.path === ADMIN_LOGIN_PATH;
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
