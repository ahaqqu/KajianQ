import { verifyBypassToken } from "@app/rate";

/**
 * The Ed25519 public key that verifies rate-limit bypass tokens (ADR-0041),
 * base64 raw — committed by design: it can only mint nothing, and the trust
 * anchor is the matching private key, which lives exclusively in the
 * environments allowed to mint (the owner's `.env` as
 * `RATE_BYPASS_PRIVATE_KEY`, mirrored as the GitHub Actions secret of the
 * same name for the staging scanner steps). Rotate by regenerating the pair,
 * committing the new public key, and re-supplying the secret.
 */
export const RATE_BYPASS_PUBLIC_KEY_B64 = "ggtNRLTrZooWoeEqtkM+NHRBiOPJGTwXiaDpGOSLFcU=";

export type BypassCheck = { ok: true; subject: string } | { ok: false; reason: string };

/**
 * Check a request's bypass header against the committed public key (tests
 * override it with a generated keypair's key). An absent header short-circuits
 * without touching crypto; verification itself never throws (fail-closed to
 * ordinary metering, reason observable in logs).
 */
export async function checkBypassHeader(
  headerValue: string | undefined,
  opts?: { bypassPublicKeyB64?: string },
): Promise<BypassCheck> {
  if (headerValue === undefined) return { ok: false, reason: "absent" };
  return verifyBypassToken(headerValue, opts?.bypassPublicKeyB64 ?? RATE_BYPASS_PUBLIC_KEY_B64);
}
