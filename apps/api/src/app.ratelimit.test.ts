import { describe, expect, it } from "vitest";
import {
  createMemoryRateLimiter,
  mintBypassToken,
  RATE_BYPASS_HEADER,
  type RateLimiterNamespace,
} from "@app/rate";
import { createApi } from "./app";
import { RATE_BYPASS_PUBLIC_KEY_B64 } from "./lib/rate-bypass";
import type { WorkerBindings } from "./env";

/**
 * 429 through the real middleware stack, without coupling to the module-level
 * global limiter or the production 120/min constant. A fresh, isolated
 * `RateLimiter` is injected via `createApi` so the test neither depends on
 * vitest module isolation nor exhausts a shared budget; `limit` is set to a
 * small value so the 429 branch is reached in a handful of requests. If the
 * 429 branch in `lib/middleware.ts` is removed, this test fails (no 429 ever
 * arrives).
 */
const env = { ASSETS: { fetch } };
const limit = 3;

describe("rate limiting", () => {
  it("allows the first N requests then returns 429 rate_limited", async () => {
    const api = createApi({ limiter: createMemoryRateLimiter(), limit });
    for (let i = 0; i < limit; i += 1) {
      const res = await api.request("/v1/health", {}, env);
      expect(res.status).toBe(200);
    }
    const res = await api.request("/v1/health", {}, env);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    // Correlation ids are set before the rate-limit short-circuit.
    expect(res.headers.get("X-Correlation-Id")).toBeTruthy();
  });

  it("resolves the Durable Object backend from the binding when no limiter is injected", async () => {
    const fakeNamespace: RateLimiterNamespace = {
      idFromName: (name: string) => ({ name }),
      get: (_id: unknown) => ({
        async check(_limit: number, _windowMs: number): Promise<boolean> {
          return false;
        },
      }),
    };
    const doEnv = {
      ASSETS: { fetch },
      RATE_LIMITER: fakeNamespace,
    } as unknown as WorkerBindings;
    // No injected limiter: middleware resolves from bindings. The fake stub
    // denies immediately, proving the DO path (the in-memory fallback would
    // allow the first request).
    const api = createApi();
    const res = await api.request("/v1/health", {}, doEnv);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  // ADR-0041: rate limiting meters the /v1 API surface only. A denying
  // limiter (every check fails) must not touch non-API paths — the doc
  // routes stand in for every unmetered path (static assets ride the same
  // "not /v1" branch through the ASSETS catch-all).
  it("never meters non-API paths, even when the limiter denies everything", async () => {
    const denying: RateLimiterNamespace = {
      idFromName: (name: string) => ({ name }),
      get: (_id: unknown) => ({
        async check(): Promise<boolean> {
          return false;
        },
      }),
    };
    const api = createApi();
    const doEnv = { ASSETS: { fetch }, RATE_LIMITER: denying } as unknown as WorkerBindings;
    for (const path of ["/docs", "/openapi.json"]) {
      const res = await api.request(path, {}, doEnv);
      expect(res.status).toBe(200);
    }
  });

  it("does not spend the per-IP budget on non-API traffic", async () => {
    const api = createApi({ limiter: createMemoryRateLimiter(), limit });
    // More non-API requests than the whole budget, then the API call must
    // still be allowed — asset bursts cannot 429 real /v1 traffic.
    for (let i = 0; i < limit + 1; i += 1) {
      const res = await api.request("/docs", {}, env);
      expect(res.status).toBe(200);
    }
    const res = await api.request("/v1/health", {}, env);
    expect(res.status).toBe(200);
  });

  // ADR-0041 bypass tokens: harness requests carrying a valid Ed25519 JWT
  // (X-Rate-Bypass) skip metering on /v1; anything else — missing, garbage,
  // wrong key — degrades to ordinary metering. Tests mint with a generated
  // keypair and override the verifier key; the committed production key is
  // only smoke-checked for importability (the private half never lives in
  // the repo).
  const bypassKeypair = async () => {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    return {
      privateKeyPkcs8B64: Buffer.from(
        await crypto.subtle.exportKey("pkcs8", kp.privateKey),
      ).toString("base64"),
      publicKeyRawB64: Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString(
        "base64",
      ),
    };
  };

  it("exempts a valid bypass token from metering even on an exhausted budget", async () => {
    const { privateKeyPkcs8B64, publicKeyRawB64 } = await bypassKeypair();
    const api = createApi({
      limiter: createMemoryRateLimiter(),
      limit,
      bypassPublicKeyB64: publicKeyRawB64,
    });
    const token = await mintBypassToken({ privateKeyPkcs8B64, subject: "test-harness" });
    for (let i = 0; i < limit; i += 1) {
      await api.request("/v1/health", {}, env);
    }
    const metered = await api.request("/v1/health", {}, env);
    expect(metered.status).toBe(429);
    const bypassed = await api.request(
      "/v1/health",
      { headers: { [RATE_BYPASS_HEADER]: token } },
      env,
    );
    expect(bypassed.status).toBe(200);
  });

  it("treats a garbage bypass token as no bypass at all", async () => {
    const { publicKeyRawB64 } = await bypassKeypair();
    const api = createApi({
      limiter: createMemoryRateLimiter(),
      limit,
      bypassPublicKeyB64: publicKeyRawB64,
    });
    for (let i = 0; i < limit; i += 1) {
      await api.request("/v1/health", {}, env);
    }
    for (const token of ["garbage", "a.b.c"]) {
      const res = await api.request(
        "/v1/health",
        { headers: { [RATE_BYPASS_HEADER]: token } },
        env,
      );
      expect(res.status).toBe(429);
    }
  });

  it("the committed bypass public key is a well-formed Ed25519 raw key", async () => {
    // Importability is the whole contract of the committed constant: the
    // verifier constructs its CryptoKey from these bytes per key rotation.
    const raw = Buffer.from(RATE_BYPASS_PUBLIC_KEY_B64, "base64");
    expect(raw.length).toBe(32);
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    expect(key.usages).toEqual(["verify"]);
  });
});
