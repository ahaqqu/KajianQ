/**
 * Secret-comparison primitives for the shared hardening surface.
 *
 * `constantTimeEqual` exists because a `===` on a credential is a comparison whose
 * *duration* reports how much of the secret matched, and the miss path of an
 * authentication endpoint is precisely where an attacker can measure it. The
 * function below never returns early: it folds every byte of the longer buffer
 * into one accumulator and folds the length difference into that same accumulator,
 * so the loop bound is the only property of the inputs it reveals.
 *
 * Callers compare **fixed-length digests**, never raw secrets of unbounded length:
 * two SHA-256 outputs are always 32 bytes, so the iteration count is a constant of
 * the construction and no input property reaches the loop bound at all.
 */

/**
 * Compare two byte buffers without an early return. A length difference is folded
 * into the result rather than short-circuiting, and bytes past a buffer's end read
 * as zero — so the comparison is exact for equal-length inputs and cannot become a
 * length oracle for unequal ones.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export function constantTimeEqual(a: Bytes, b: Bytes): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** SHA-256 of a string (UTF-8) or byte buffer, as raw bytes. Web Crypto only: the
 * same call works in the Bun serving runtime and in a browser test. */
export function sha256(input: string | Bytes): Promise<Bytes> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return crypto.subtle.digest("SHA-256", bytes).then((digest) => new Uint8Array(digest));
}

/** HMAC-SHA256 over a message with raw key bytes. */
export function hmacSha256(key: Bytes, message: string): Promise<Bytes> {
  const cryptoKey = crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return cryptoKey
    .then((imported) => crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(message)))
    .then((signature) => new Uint8Array(signature));
}

/** Lowercase hex, the form fingerprints and signatures are compared and logged in. */
export function toHex(bytes: Bytes): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
