import { hmacSha256, sha256, toHex } from "@app/hardening";

/**
 * A signer for a token shape this session model must refuse and a real deployment has
 * actually issued: a payload carrying `exp` and no session id, signed with the same
 * credential-derived key the current code uses. The pre-change mint carried `{ exp,
 * nonce }`; this signer drops the nonce — which `verifySessionClaims` never reads — so
 * `{ exp }` alone is the shortest payload that reproduces the difference the refusal
 * keys on: the absent `jti`.
 *
 * It exists so the refusal is observable rather than vacuous. Signing a payload that also
 * names a `jti` with `tokenSignature` is accepted by `verifySessionClaims`, so a token
 * built here differs from an accepted one by the missing session id alone — the
 * signature, the version and the expiry are all valid, and the verifier reads no other
 * field.
 *
 * `KEY_LABEL` pins the key derivation `admin-auth.ts` performs; a change there reddens the
 * control assertion in `admin-auth.test.ts` instead of silently turning this signer into a
 * second, wrong key.
 */
const KEY_LABEL = "kajianq/admin-session-key/v1\n";

/** Base64url, the token's payload encoding (no padding). */
export function base64url(value: unknown): string {
  const raw = JSON.stringify(value);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** The signature `admin-auth.ts` would put on a `v1` payload for this credential. */
export async function tokenSignature(credential: string, payload: string): Promise<string> {
  const key = await sha256(`${KEY_LABEL}${credential}`);
  return toHex(await hmacSha256(key, `v1.${payload}`));
}

/** A validly signed legacy token: `{ exp }` only, no `jti`, so nothing can revoke it. */
export async function legacyAdminToken(credential: string, exp: number): Promise<string> {
  const payload = base64url({ exp });
  return `v1.${payload}.${await tokenSignature(credential, payload)}`;
}
