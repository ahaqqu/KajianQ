/**
 * Rate-limit bypass tokens (ADR-0041): short-lived Ed25519-signed JWTs that
 * exempt a request from rate metering. The private key lives only in the
 * harness environments that mint tokens (local `.env`, the GitHub Actions
 * secret `RATE_BYPASS_PRIVATE_KEY`); the matching public key is committed in
 * the API composition root, so verification is deployable everywhere without
 * a key-management surface. The bypass skips metering only — it is never a
 * session credential: handlers still require their own auth.
 *
 * Pure WebCrypto + JWT compact serialization — no vendor or domain coupling,
 * runs identically in the Workers runtime, Bun, and Node ≥ 18.
 */

/** The only purpose claim a bypass token may carry. */
export const RATE_BYPASS_PURPOSE = "rate-bypass" as const;

/**
 * The header carrying the token. A dedicated header (not Authorization):
 * the bypass is not an identity, and reusing the auth header would invite
 * exactly that confusion.
 */
export const RATE_BYPASS_HEADER = "X-Rate-Bypass" as const;

export type BypassClaims = {
  /** Who minted/holds the token — required, logged on every bypassed request. */
  sub: string;
  /** Fixed: `rate-bypass`. Anything else fails verification. */
  purpose: typeof RATE_BYPASS_PURPOSE;
  /** Expiry, epoch seconds — strictly in the future at verify time. */
  exp: number;
};

export type BypassVerifyResult = { ok: true; subject: string } | { ok: false; reason: string };

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const b64urlJson = (value: unknown): string =>
  b64url(new TextEncoder().encode(JSON.stringify(value)));

const enc = new TextEncoder();

function importVerifyKey(publicKeyRawB64: string): Promise<CryptoKey> {
  const raw = Buffer.from(publicKeyRawB64, "base64");
  return crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
}

async function importSignKey(privateKeyPkcs8B64: string): Promise<CryptoKey> {
  const der = Buffer.from(privateKeyPkcs8B64, "base64");
  return crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
}

/**
 * Mint a bypass token. `privateKeyPkcs8B64` is the base64 PKCS8 Ed25519
 * private key (the `RATE_BYPASS_PRIVATE_KEY` secret). Throws on a malformed
 * key — minting is a trusted harness operation, not a request path.
 */
export async function mintBypassToken(options: {
  privateKeyPkcs8B64: string;
  subject: string;
  /** Lifetime in seconds; defaults to one hour. */
  ttlSeconds?: number;
  now?: () => number;
}): Promise<string> {
  const nowMs = (options.now ?? Date.now)();
  const claims: BypassClaims = {
    sub: options.subject,
    purpose: RATE_BYPASS_PURPOSE,
    exp: Math.floor(nowMs / 1000) + (options.ttlSeconds ?? 3_600),
  };
  const header = b64urlJson({ alg: "EdDSA", typ: "JWT" });
  const payload = b64urlJson(claims);
  const key = await importSignKey(options.privateKeyPkcs8B64);
  const signature = await crypto.subtle.sign("Ed25519", key, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

/**
 * Verify a bypass token. Never throws — every failure (bad shape, wrong
 * key, wrong purpose, missing subject, expired) returns `ok: false` with a
 * reason, so a bad bypass header degrades to ordinary rate metering and is
 * observable in logs, never a 5xx.
 */
export async function verifyBypassToken(
  token: string,
  publicKeyRawB64: string,
  now: () => number = Date.now,
): Promise<BypassVerifyResult> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed_token" };
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString()) as {
      alg?: string;
    };
    if (header.alg !== "EdDSA") return { ok: false, reason: "unexpected_alg" };
    const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as Record<
      string,
      unknown
    >;
    if (claims.purpose !== RATE_BYPASS_PURPOSE) return { ok: false, reason: "wrong_purpose" };
    if (typeof claims.sub !== "string" || claims.sub.length === 0)
      return { ok: false, reason: "missing_subject" };
    if (typeof claims.exp !== "number" || claims.exp <= Math.floor(now() / 1000))
      return { ok: false, reason: "expired" };
    const valid = await crypto.subtle.verify(
      "Ed25519",
      await importVerifyKey(publicKeyRawB64),
      Buffer.from(signatureB64, "base64url"),
      enc.encode(`${headerB64}.${payloadB64}`),
    );
    return valid ? { ok: true, subject: claims.sub } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "malformed_token" };
  }
}
