import { secureHeaders } from "hono/secure-headers";
import type { Hono } from "hono";
import type { ApiEnv } from "../env";
import { corsGuard } from "./cors";
import { allowRequest } from "./rate-limit-mw";

/** Installs the cross-cutting middleware every route shares. */
export function applyMiddleware(api: Hono<ApiEnv>): void {
  api.use("*", secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "https://sentry.io"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  }));
  api.use("*", corsGuard);
  api.use("*", async (c, next) => {
    const id = c.req.header("X-Correlation-Id") ?? crypto.randomUUID();
    c.set("correlationId", id);
    c.header("X-Correlation-Id", id);
    const ip = c.req.header("CF-Connecting-IP") ?? "local";
    if (!(await allowRequest(`ip:${ip}`))) {
      return c.json({ error: "rate_limited" }, 429);
    }
    await next();
  });
}
