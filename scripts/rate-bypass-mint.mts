#!/usr/bin/env bun
/**
 * Mint a rate-limit bypass token (ADR-0041) from RATE_BYPASS_PRIVATE_KEY.
 * Bun auto-loads `.env`, so the key can live there locally; CI supplies it
 * as the GitHub Actions secret of the same name. The token is printed to
 * stdout — pass it as the `X-Rate-Bypass` header of harness requests
 * (schemathesis, ZAP, load tests). A token grants nothing but metering
 * exemption on /v1; handlers still enforce their own auth.
 *
 * Usage: bun run rate:bypass [--ttl-seconds 3600] [--sub ci]
 */
import { mintBypassToken } from "../packages/rate/src/index.ts";

const args = process.argv.slice(2);
// Flags are optional, but a flag that is present must carry a value —
// `--sub` as the last argv item (or followed by another flag) is a caller
// error, not a silent default.
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`${name} requires a value (e.g. ${name} 3600).`);
    process.exit(1);
  }
  return value;
};

const privateKeyPkcs8B64 = process.env.RATE_BYPASS_PRIVATE_KEY;
if (!privateKeyPkcs8B64) {
  console.error(
    "RATE_BYPASS_PRIVATE_KEY is not set — it must hold the base64 PKCS8 Ed25519 private key (ADR-0041).",
  );
  process.exit(1);
}

// A non-numeric TTL would otherwise become `exp: null` — a well-formed-looking
// token that verifies as expired on every request. Fail loudly instead.
const ttlFlag = flag("--ttl-seconds");
const ttlSeconds = ttlFlag === undefined ? 3_600 : Number(ttlFlag);
if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
  console.error(`--ttl-seconds must be a positive number of seconds, got "${ttlFlag}".`);
  process.exit(1);
}

const token = await mintBypassToken({
  privateKeyPkcs8B64,
  subject: flag("--sub") ?? "unspecified",
  ttlSeconds,
});
console.log(token);
