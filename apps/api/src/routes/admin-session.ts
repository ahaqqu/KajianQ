import { ADMIN_SESSION_ROUTE } from "../lib/admin-paths";
import {
  adminCredential,
  adminUnauthorized,
  clearAdminCookies,
  csrfMatches,
  issueSessionToken,
  sameOrigin,
  setAdminCookie,
  setCsrfCookie,
} from "../lib/admin-auth";
import { loginBodyMatches } from "../lib/admin-login";
import { adminSessionActive, revokePresentedSession } from "../lib/admin-route";
import { newRouter } from "../lib/guard";

/**
 * The admin surface's session routes (ADR-0064): probe, login, logout.
 *
 * The login POST is the only state-changing unauthenticated request on the admin
 * surface, so it carries the full set of controls and every auth control answers
 * the same 401: a cross-site Origin, a missing CSRF pair, a media type other than
 * JSON, a wrong credential, a body that is not the contract, and a surface with no
 * credential configured at all. Nothing distinguishes them from outside, so the
 * endpoint is not a probe for whether an admin credential exists — and a malformed
 * body or a foreign media type cannot become an oracle for the credential's presence.
 *
 * Login is rate-limited by the admin middleware (a tighter budget than the public
 * `/v1` meter), so a guessing loop never reaches the comparison at full speed.
 *
 * The probe answers whether a live session is held, which means the token's session
 * id is checked against the revocation denylist: a signed-out session reads as signed
 * out here too. Logout revokes that session id before it clears the cookies, so the
 * pre-logout token is dead the moment the response says 204; its absence or an
 * already-invalid token still answers 204 and clears, keeping every miss uniform.
 */

function sessionBody(authenticated: boolean, csrfToken: string) {
  return { authenticated, csrfToken };
}

export const adminSessionRoutes = newRouter()
  // Bootstrap: a fresh CSRF token every time, plus whether a live session is
  // already held. Reachable without a session by construction — it is how the
  // login form obtains the token its POST must echo.
  .get(ADMIN_SESSION_ROUTE, async (c) => {
    const csrfToken = setCsrfCookie(c);
    c.header("Cache-Control", "no-store");
    return c.json(sessionBody(await adminSessionActive(c, c.env), csrfToken));
  })
  .post(ADMIN_SESSION_ROUTE, async (c) => {
    const credential = adminCredential(c.env);
    // Every failure is the same 401. An unconfigured surface reads as a miss before
    // any other check, so its answer never depends on the request's Origin or body.
    if (credential === null) return adminUnauthorized(c);
    // The cross-site check is next: cheapest, and it touches no secret. With
    // `ALLOWED_ORIGINS` unset it fails closed behind the TLS proxy, where the API
    // sees an http request URL and cannot vouch for the browser's https origin.
    if (!sameOrigin(c)) {
      // The only operator-visible signal that separates a stale or absent allowlist
      // from a wrong password. Route-only: neither the refused Origin nor the request
      // host enters the log, and the response stays the uniform 401.
      c.get("ctx").logger.warn("admin.login_origin_refused", { route: "admin.login" });
      return adminUnauthorized(c);
    }
    if (!(await csrfMatches(c))) return adminUnauthorized(c);
    // The media type, the body and the credential are one boundary: a request the
    // server will not read is the same miss as a wrong password.
    if (!(await loginBodyMatches(c, credential))) return adminUnauthorized(c);
    const { token } = await issueSessionToken(credential);
    setAdminCookie(c, token);
    // Rotating the CSRF token on privilege change keeps a token obtained before
    // login from being reusable after it.
    const csrfToken = setCsrfCookie(c);
    c.header("Cache-Control", "no-store");
    return c.json(sessionBody(true, csrfToken));
  })
  .delete(ADMIN_SESSION_ROUTE, async (c) => {
    // Logout: a cross-site logout is a nuisance rather than a compromise, but the
    // CSRF pair is required all the same so every state change has one rule.
    if (!(await csrfMatches(c))) return adminUnauthorized(c);
    if (!(await revokePresentedSession(c, c.env))) {
      // The revocation could not be written, so the token would stay live. Reporting
      // 204 and clearing the cookie would be a sign-out that did not happen; the
      // cookie stays where it was and the operator can retry.
      return c.json({ error: "admin_unavailable" }, 503);
    }
    clearAdminCookies(c);
    return c.body(null, 204);
  });
