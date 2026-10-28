import { describe, expect, it } from "vite-plus/test";
import {
  ADMIN_SESSION_TTL_MS,
  adminActor,
  credentialMatches,
  isJsonContentType,
  issueSessionToken,
  newCsrfToken,
  verifySessionClaims,
} from "./admin-auth";

/**
 * The credential and session primitives, without HTTP.
 *
 * The invariants: the credential comparison is true for exactly one input; a session
 * token is unforgeable without the credential and dies when the credential rotates
 * (the signing key is derived from it); an expired token is a miss; every token names
 * one random session so a sign-out can end exactly that session; and the actor
 * fingerprint identifies a credential version without storing the credential or
 * anything an offline guess could confirm.
 *
 * The media-type check is the login boundary's first gate, so its truth table is
 * pinned here: only JSON reaches a body parser, and a browser form's encodings do not.
 */
const CREDENTIAL = "correct horse battery staple";

function decodePayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1] ?? "";
  const raw = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("credentialMatches", () => {
  it("is true for exactly the configured credential", async () => {
    expect(await credentialMatches(CREDENTIAL, CREDENTIAL)).toBe(true);
    expect(await credentialMatches(`${CREDENTIAL} `, CREDENTIAL)).toBe(false);
    expect(await credentialMatches(CREDENTIAL.toUpperCase(), CREDENTIAL)).toBe(false);
    expect(await credentialMatches("", CREDENTIAL)).toBe(false);
    // A digest-equal prefix proves nothing: the comparison is over whole digests.
    expect(await credentialMatches(CREDENTIAL.slice(0, 5), CREDENTIAL)).toBe(false);
  });
});

describe("session tokens", () => {
  it("round-trips a token minted for the same credential, with its session id", async () => {
    const { token, jti, expiresAt } = await issueSessionToken(CREDENTIAL, 1_000);
    expect(expiresAt).toBe(1_000 + ADMIN_SESSION_TTL_MS);
    expect(jti).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await verifySessionClaims(CREDENTIAL, token, 1_000)).toEqual({ jti, expiresAt });
  });

  it("rejects a token minted for another credential (rotation invalidates sessions)", async () => {
    const { token } = await issueSessionToken(CREDENTIAL, 1_000);
    expect(await verifySessionClaims(`${CREDENTIAL}!`, token, 1_000)).toBeNull();
    expect(await verifySessionClaims("", token, 1_000)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const { token, expiresAt } = await issueSessionToken(CREDENTIAL, 1_000);
    expect(await verifySessionClaims(CREDENTIAL, token, expiresAt)).toBeNull();
    expect(await verifySessionClaims(CREDENTIAL, token, expiresAt - 1)).not.toBeNull();
  });

  it("keeps the credential out of the token payload", async () => {
    const { token } = await issueSessionToken(CREDENTIAL, 1_000);
    const payload = decodePayload(token);
    expect(payload.exp).toBe(1_000 + ADMIN_SESSION_TTL_MS);
    expect(typeof payload.jti).toBe("string");
    // The token is readable by anyone holding the cookie; it may name the session, never
    // the credential that signs it.
    expect(JSON.stringify(payload)).not.toContain(CREDENTIAL);
  });

  it("rejects every forged shape without throwing", async () => {
    const { token } = await issueSessionToken(CREDENTIAL, 1_000);
    const [version, payload, signature] = token.split(".");
    const forged = [
      "",
      "not-a-token",
      `v2.${payload}.${signature}`,
      // A payload swapped for another (valid-looking) one keeps the old signature,
      // which is precisely what the signature check must refuse.
      `${version}.${btoa(JSON.stringify({ exp: 9_999_999_999_999, jti: "x".repeat(22) })).replaceAll("=", "")}.${signature}`,
      `${version}.${payload}.${"0".repeat(signature!.length)}`,
      `${version}.${payload}`,
      // A payload that decodes but was never signed by the key.
      `${version}.${btoa(JSON.stringify({ exp: Date.now() + 1e9 }))}.${signature}`,
      // The trap this session model adds: a signed token must name a session. Swapping
      // in a payload with no `jti` — a token that cannot be revoked — is the same miss.
      `${version}.${btoa(JSON.stringify({ exp: Date.now() + 1e9 })).replaceAll("=", "")}.${signature}`,
    ];
    for (const candidate of forged) {
      expect(await verifySessionClaims(CREDENTIAL, candidate, 1_000), candidate).toBeNull();
    }
  });

  it("mints a distinct session id and token per login", async () => {
    const first = await issueSessionToken(CREDENTIAL, 1_000);
    const second = await issueSessionToken(CREDENTIAL, 1_000);
    expect(first.token).not.toBe(second.token);
    expect(first.jti).not.toBe(second.jti);
    expect(await verifySessionClaims(CREDENTIAL, second.token, 1_000)).not.toBeNull();
  });
});

describe("isJsonContentType: only the declared JSON type reaches the body parser", () => {
  it("accepts application/json with an optional charset parameter", () => {
    for (const value of [
      "application/json",
      "application/json; charset=utf-8",
      "application/json;charset=UTF-8",
      "Application/JSON; Charset=Utf-8",
      " application/json ",
    ]) {
      expect(isJsonContentType(value), value).toBe(true);
    }
  });

  it("refuses every other declared type, a missing header, and a malformed parameter", () => {
    for (const value of [
      undefined,
      "",
      "text/plain",
      "text/plain;charset=utf-8",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=----x",
      "application/json-patch+json",
      "text/application/json",
      "application/json; charset",
      "application/json; foo=bar",
    ]) {
      expect(isJsonContentType(value), String(value)).toBe(false);
    }
  });
});

describe("adminActor", () => {
  it("is a stable, keyed pseudonym that is neither the credential nor its hash", async () => {
    const actor = await adminActor(CREDENTIAL);
    expect(actor).toMatch(/^[0-9a-f]{16}$/);
    expect(actor).toBe(await adminActor(CREDENTIAL));
    expect(actor).not.toBe(await adminActor(`${CREDENTIAL}!`));
    expect(actor).not.toContain(CREDENTIAL);
    // It is not a plain digest of the credential: a SHA-256 of the password would be
    // confirmable offline against a guessed credential.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CREDENTIAL));
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(actor).not.toBe(hex.slice(0, 16));
  });
});

describe("newCsrfToken", () => {
  it("is fresh and long enough to be unguessable", () => {
    const tokens = new Set(Array.from({ length: 32 }, () => newCsrfToken()));
    expect(tokens.size).toBe(32);
    for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{48}$/);
  });
});
