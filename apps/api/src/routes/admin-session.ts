import { AdminLoginRequestSchema, type AdminSession } from "@app/contracts";
import * as v from "valibot";
import {
  adminCredential,
  adminSessionActive,
  adminUnauthorized,
  clearAdminCookies,
  credentialMatches,
  csrfMatches,
  issueSessionToken,
  sameOrigin,
  setAdminCookie,
  setCsrfCookie,
} from "../lib/admin-auth";
import { newRouter } from "../lib/guard";

/**
 * The admin surface's session routes (ADR-0064): probe, login, logout.
 *
 * The login POST is the only state-changing unauthenticated request on the whole
 * API, so it carries the full set of controls and every auth control answers the
 * same 401: a cross-site Origin, a missing CSRF pair, a wrong credential, and a
 * surface with no credential configured at all. Nothing distinguishes them from
 * outside, so the endpoint is not a probe for whether an admin credential exists.
 * A body that is not the contract is the one 400 — a malformed request is not a
 * credential miss.
 *
 * Login is rate-limited by the admin middleware (a tighter budget than the public
 * `/v1` meter), so a guessing loop never reaches the comparison at full speed.
 */

function sessionBody(authenticated: boolean, csrfToken: string): AdminSession {
  return { authenticated, csrfToken };
}

export const adminSessionRoutes = newRouter()
  // Bootstrap: a fresh CSRF token every time, plus whether a live session is
  // already held. Reachable without a session by construction — it is how the
  // login form obtains the token its POST must echo.
  .get("/admin/v1/session", async (c) => {
    const csrfToken = setCsrfCookie(c);
    c.header("Cache-Control", "no-store");
    return c.json(sessionBody(await adminSessionActive(c, c.env), csrfToken));
  })
  .post("/admin/v1/session", async (c) => {
    const credential = adminCredential(c.env);
    // Order: cross-site first (cheapest, no secret touched), then the CSRF pair,
    // then the credential. Every failure is the same 401.
    if (credential === null || !sameOrigin(c) || !(await csrfMatches(c))) {
      return adminUnauthorized(c);
    }
    let body: unknown;
    try {
      body = await c.req.raw.json();
    } catch {
      body = null;
    }
    const parsed = v.safeParse(AdminLoginRequestSchema, body);
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    if (!(await credentialMatches(parsed.output.password, credential))) {
      return adminUnauthorized(c);
    }
    const { token } = await issueSessionToken(credential);
    setAdminCookie(c, token);
    // Rotating the CSRF token on privilege change keeps a token obtained before
    // login from being reusable after it.
    const csrfToken = setCsrfCookie(c);
    c.header("Cache-Control", "no-store");
    return c.json(sessionBody(true, csrfToken));
  })
  .delete("/admin/v1/session", async (c) => {
    // Logout: a cross-site logout is a nuisance rather than a compromise, but the
    // CSRF pair is required all the same so every state change has one rule.
    if (!(await csrfMatches(c))) return adminUnauthorized(c);
    clearAdminCookies(c);
    return c.body(null, 204);
  });
