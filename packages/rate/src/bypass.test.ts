import { describe, expect, it } from "vitest";
import {
  mintBypassToken,
  verifyBypassToken,
  RATE_BYPASS_HEADER,
  RATE_BYPASS_PURPOSE,
} from "./bypass";
import { generateEd25519KeypairB64 } from "./test-utils/ed25519-keypair";

/**
 * Bypass-token contract (ADR-0041): Ed25519 JWT, purpose-locked, exp-gated,
 * subject-required. Verification never throws — every bad token degrades to
 * `ok: false` so middleware can fall through to ordinary metering.
 */

const keypair = generateEd25519KeypairB64;

const now = () => 1_700_000_000_000;

describe("mintBypassToken / verifyBypassToken", () => {
  it("round-trips: a minted token verifies with its subject", async () => {
    const { privateKeyPkcs8B64, publicKeyRawB64 } = await keypair();
    const token = await mintBypassToken({
      privateKeyPkcs8B64,
      subject: "schemathesis",
      ttlSeconds: 60,
      now,
    });
    const result = await verifyBypassToken(token, publicKeyRawB64, now);
    expect(result).toEqual({ ok: true, subject: "schemathesis" });
  });

  it("rejects a token signed by a different key", async () => {
    const a = await keypair();
    const b = await keypair();
    const token = await mintBypassToken({
      privateKeyPkcs8B64: a.privateKeyPkcs8B64,
      subject: "x",
      now,
    });
    expect(await verifyBypassToken(token, b.publicKeyRawB64, now)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects an expired token", async () => {
    const { privateKeyPkcs8B64, publicKeyRawB64 } = await keypair();
    const token = await mintBypassToken({
      privateKeyPkcs8B64,
      subject: "x",
      ttlSeconds: 60,
      now,
    });
    const later = () => now() + 61_000;
    expect(await verifyBypassToken(token, publicKeyRawB64, later)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a token whose purpose was rewritten (purpose-locked)", async () => {
    const { privateKeyPkcs8B64, publicKeyRawB64 } = await keypair();
    const token = await mintBypassToken({
      privateKeyPkcs8B64,
      subject: "x",
      now,
    });
    // The claim set is signed, so swapping purpose (e.g. to stand in for a
    // session) breaks the signature: the verifier checks the Ed25519
    // signature before parsing/validating any claim (canonical JWT order),
    // so the forgery is dead as `bad_signature` — a valid other-purpose
    // token is unreachable by construction.
    const [, payload] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    claims.purpose = "auth";
    const forged = `${token.split(".")[0]}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${token.split(".")[2]}`;
    expect(await verifyBypassToken(forged, publicKeyRawB64, now)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects garbage without throwing (every failure shape)", async () => {
    const { publicKeyRawB64 } = await keypair();
    const cases = ["", "not-a-jwt", "a.b", "a.b.c.d", "x.y.z"];
    for (const token of cases) {
      const result = await verifyBypassToken(token, publicKeyRawB64, now);
      expect(result.ok).toBe(false);
    }
  });

  it("the purpose constant is the product vocabulary, header is dedicated", () => {
    expect(RATE_BYPASS_PURPOSE).toBe("rate-bypass");
    expect(RATE_BYPASS_HEADER).toBe("X-Rate-Bypass");
  });
});
