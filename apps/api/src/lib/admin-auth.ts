import { constantTimeEqual, hmacSha256, sha256, toHex, type Bytes } from "@app/hardening";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { allowedOrigins, type ApiEnv, type AppBindings } from "../env";
import { ADMIN_COOKIE_PATH } from "./admin-paths";

/**
 * The admin credential and session (ADR-0064) — a surface separate from the
 * anonymous Bearer session (ADR-0017), which it never touches or widens.
 *
 * The invariant: **nothing on the admin surface is readable without the
 * env-configured credential**, and a miss is indistinguishable from any other
 * miss. Concretely —
 *
 *  - the credential is compared through SHA-256 digests with a constant-time fold
 *    (`constantTimeEqual`), so a wrong credential's timing says nothing about how
 *    much of it matched, and both compared buffers are always 32 bytes;
 *  - the session is a stateless HMAC-signed token whose key is derived from the
 *    credential, so there is no in-process session table (one instance is the
 *    posture, not an assumption, ADR-0050) and rotating the credential invalidates
 *    every outstanding session; the token carries a random session id so a sign-out
 *    can revoke exactly that session in a shared denylist, leaving every other live
 *    session alone;
 *  - a missing credential, a missing cookie, a malformed token, a bad signature, an
 *    expired token and a revoked session id are ONE answer: `401
 *    {"error":"unauthorized"}`;
 *  - the cookie is httpOnly, SameSite=Strict and Secure outside development, and is
 *    scoped to the admin API prefix, so no public `/v1` route ever receives it.
 *
 * The one value this module derives that leaves the process is the **actor**
 * fingerprint: an HMAC of a fixed label under the session key, truncated to 16 hex
 * characters. It identifies a credential version in the access log without storing
 * the credential, a hash of it, or anything an offline guess could confirm.
 */

/** The session cookie. Never readable from script, never sent cross-site. */
export const ADMIN_COOKIE = "kajianq_admin";

/** The CSRF cookie. Its value is echoed back in the login request's header. */
export const ADMIN_CSRF_COOKIE = "kajianq_admin_csrf";

/** How long a login lasts. A count that is a rule, so it is a constant. */
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const SESSION_VERSION = "v1";
const KEY_LABEL = "kajianq/admin-session-key/v1\n";
const ACTOR_LABEL = "kajianq/admin-actor/v1";
const CSRF_HEADER = "x-csrf-token";

/** The random session id's width and shape: 128 random bits, base64url (22 chars). */
const SESSION_ID_BYTES = 16;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** What a verified token proves: which session it is, and when it stops being valid. */
export type AdminSessionClaims = { jti: string; expiresAt: number };

/** The configured credential, or null when the admin surface is disabled. */
export function adminCredential(bindings: AppBindings): string | null {
  const value = bindings.ADMIN_PASSWORD;
  return value === undefined || value === "" ? null : value;
}

function base64url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** The signing key: SHA-256 over a fixed label and the credential, so the
 * credential itself never becomes a key and rotating it rotates the key. */
function sessionKey(credential: string): Promise<Bytes> {
  return sha256(`${KEY_LABEL}${credential}`);
}

async function sign(credential: string, payload: string): Promise<string> {
  return toHex(await hmacSha256(await sessionKey(credential), `${SESSION_VERSION}.${payload}`));
}

/** True only for exactly the configured credential. Constant-time on digests. */
export async function credentialMatches(provided: string, credential: string): Promise<boolean> {
  return constantTimeEqual(await sha256(provided), await sha256(credential));
}

/** Mint a session token for a credential that has just been verified. */
export async function issueSessionToken(
  credential: string,
  now: number = Date.now(),
): Promise<{ token: string; jti: string; expiresAt: number }> {
  const expiresAt = now + ADMIN_SESSION_TTL_MS;
  const jti = base64url(crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTES)));
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ exp: expiresAt, jti })));
  return {
    token: `${SESSION_VERSION}.${payload}.${await sign(credential, payload)}`,
    jti,
    expiresAt,
  };
}

/**
 * Verify a session token: the shape, the signature (constant-time over digests),
 * then the expiry and the session id. Anything else is null, which the caller
 * answers as a uniform 401 — an expired token, a forged one and a payload with no
 * session id are the same miss.
 */
export async function verifySessionClaims(
  credential: string,
  token: string,
  now: number = Date.now(),
): Promise<AdminSessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION) return null;
  const payload = parts[1];
  const signature = parts[2];
  if (payload === undefined || signature === undefined || fromBase64url(payload) === null) {
    return null;
  }
  const expected = await sign(credential, payload);
  if (!constantTimeEqual(await sha256(expected), await sha256(signature))) return null;
  try {
    const decoded: unknown = JSON.parse(
      new TextDecoder().decode(fromBase64url(payload) ?? new Uint8Array()),
    );
    if (typeof decoded !== "object" || decoded === null) return null;
    const { exp, jti } = decoded as { exp?: unknown; jti?: unknown };
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= now) return null;
    if (typeof jti !== "string" || !SESSION_ID_PATTERN.test(jti)) return null;
    return { jti, expiresAt: exp };
  } catch {
    return null;
  }
}

/** The stable pseudonym the access log records as "who". */
export async function adminActor(credential: string): Promise<string> {
  return toHex(await hmacSha256(await sessionKey(credential), ACTOR_LABEL)).slice(0, 16);
}

/** A fresh CSRF token (192 random bits, hex). */
export function newCsrfToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(24)));
}

function secureCookies(c: Context<ApiEnv>): boolean {
  // The development posture serves plain http on loopback; staging and production
  // sit behind TLS, where a Secure cookie is the only acceptable form.
  return c.get("ctx")?.envName !== undefined && c.get("ctx").envName !== "development";
}

/** Set the session cookie, scoped to the admin API only. */
export function setAdminCookie(c: Context<ApiEnv>, token: string): void {
  setCookie(c, ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: secureCookies(c),
    path: ADMIN_COOKIE_PATH,
    maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000),
  });
}

/** Set (or refresh) the CSRF cookie and return its value for the response body. */
export function setCsrfCookie(c: Context<ApiEnv>): string {
  const token = newCsrfToken();
  setCookie(c, ADMIN_CSRF_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: secureCookies(c),
    path: ADMIN_COOKIE_PATH,
    maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000),
  });
  return token;
}

/** Clear both cookies on logout, with the same attributes they were set with. */
export function clearAdminCookies(c: Context<ApiEnv>): void {
  const options = {
    path: ADMIN_COOKIE_PATH,
    sameSite: "Strict" as const,
    secure: secureCookies(c),
  };
  deleteCookie(c, ADMIN_COOKIE, options);
  deleteCookie(c, ADMIN_CSRF_COOKIE, options);
}

/**
 * CSRF check for the login POST: the `X-CSRF-Token` header must carry the value of
 * the CSRF cookie. A cross-site page can make the browser send the cookie but
 * cannot read it (httpOnly) nor set the header on a form submission, so the pair
 * cannot be produced from another origin. Compared through digests, constant-time.
 */
export async function csrfMatches(c: Context<ApiEnv>): Promise<boolean> {
  const cookie = getCookie(c, ADMIN_CSRF_COOKIE);
  const header = c.req.header(CSRF_HEADER);
  if (cookie === undefined || cookie === "" || header === undefined || header === "") {
    return false;
  }
  return constantTimeEqual(await sha256(cookie), await sha256(header));
}

/**
 * True when the request carries no cross-site Origin. An absent Origin is a
 * same-origin fetch from a client that omits it; anything else must match.
 *
 * The configured public origin (`ALLOWED_ORIGINS`) is the only source that can vouch
 * for the browser's origin — the same rule `resolveCorsOrigin` applies to every other
 * browser call. Behind the TLS-terminating nginx the API is a plain-HTTP listener, so
 * it sees `http://<host>` while the browser sends `https://<host>`; the request URL
 * describes that hop, not the browser, so it is not a fallback and an unset allowlist
 * refuses every Origin-carrying login. A forwarded `X-Forwarded-Proto` is a proxy's
 * claim about the scheme, not the caller's origin, and is never read here.
 */
export function sameOrigin(c: Context<ApiEnv>): boolean {
  const origin = c.req.header("origin");
  if (origin === undefined) return true;
  return allowedOrigins(c.env.ALLOWED_ORIGINS).includes(origin);
}

export type AdminIdentity = AdminSessionClaims & { actor: string };

/**
 * The guard every admin route runs before it touches the store: resolve the
 * credential, verify the session cookie, derive the actor. Every miss returns the
 * same 401 body — including "the admin surface is not configured in this
 * environment", which must read as a miss rather than as a configuration hint.
 * The session id is returned with the identity so the caller can reject a revoked
 * one; the token itself stays inside this module.
 */
export async function adminGuard(
  c: Context<ApiEnv>,
  bindings: AppBindings,
): Promise<AdminIdentity | Response> {
  const credential = adminCredential(bindings);
  const token = getCookie(c, ADMIN_COOKIE);
  if (credential === null || token === undefined || token === "") {
    return adminUnauthorized(c);
  }
  const claims = await verifySessionClaims(credential, token);
  if (claims === null) return adminUnauthorized(c);
  return { ...claims, actor: await adminActor(credential) };
}

/**
 * The login POST's declared media type: `application/json`, with an optional
 * `charset` parameter. A missing header or any other declared type is refused as
 * the same miss as a wrong credential, so the media type is part of the login
 * boundary rather than a hint the body parser ignores.
 */
export function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const [mediaType, ...parameters] = value.split(";").map((part) => part.trim());
  if (mediaType?.toLowerCase() !== "application/json") return false;
  return parameters.every((parameter) => parameter === "" || /^charset=[^;\s]+$/i.test(parameter));
}

/** The one unauthorized answer the admin surface gives. */
export function adminUnauthorized(c: Context<ApiEnv>): Response {
  c.header("Cache-Control", "no-store");
  return c.json({ error: "unauthorized" }, 401);
}
