import { describe, expect, it } from "vite-plus/test";
import {
  adminActor,
  credentialMatches,
  issueSessionToken,
  newCsrfToken,
  verifySessionToken,
  ADMIN_SESSION_TTL_MS,
} from "./admin-auth";

/**
 * The credential and session primitives, without HTTP.
 *
 * The invariants: the credential comparison is true for exactly one input; a session
 * token is unforgeable without the credential and dies when the credential rotates
 * (the signing key is derived from it); an expired token is a miss; and the actor
 * fingerprint identifies a credential version without storing the credential or
 * anything an offline guess could confirm.
 */
const CREDENTIAL = "correct horse battery staple";

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
  it("round-trips a token minted for the same credential", async () => {
    const { token, expiresAt } = await issueSessionToken(CREDENTIAL, 1_000);
    expect(expiresAt).toBe(1_000 + ADMIN_SESSION_TTL_MS);
    expect(await verifySessionToken(CREDENTIAL, token, 1_000)).toBe(true);
  });

  it("rejects a token minted for another credential (rotation invalidates sessions)", async () => {
    const { token } = await issueSessionToken(CREDENTIAL, 1_000);
    expect(await verifySessionToken(`${CREDENTIAL}!`, token, 1_000)).toBe(false);
    expect(await verifySessionToken("", token, 1_000)).toBe(false);
  });

  it("rejects an expired token", async () => {
    const { token, expiresAt } = await issueSessionToken(CREDENTIAL, 1_000);
    expect(await verifySessionToken(CREDENTIAL, token, expiresAt)).toBe(false);
    expect(await verifySessionToken(CREDENTIAL, token, expiresAt - 1)).toBe(true);
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
      `${version}.${btoa(JSON.stringify({ exp: 9_999_999_999_999, nonce: "x" })).replaceAll("=", "")}.${signature}`,
      `${version}.${payload}.${"0".repeat(signature!.length)}`,
      `${version}.${payload}`,
      // A payload that decodes but was never signed by the key.
      `${version}.${btoa(JSON.stringify({ exp: Date.now() + 1e9 }))}.${signature}`,
    ];
    for (const candidate of forged) {
      expect(await verifySessionToken(CREDENTIAL, candidate, 1_000), candidate).toBe(false);
    }
  });

  it("mints a distinct token per login", async () => {
    const first = await issueSessionToken(CREDENTIAL, 1_000);
    const second = await issueSessionToken(CREDENTIAL, 1_000);
    expect(first.token).not.toBe(second.token);
    expect(await verifySessionToken(CREDENTIAL, second.token, 1_000)).toBe(true);
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
