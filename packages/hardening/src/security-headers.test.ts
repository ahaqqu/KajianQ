import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  DEFAULT_CSP,
  DEFAULT_PERMISSIONS_POLICY,
  installSecurityHeaders,
  type HardeningOptions,
} from "./security-headers";

function appWith(opts?: HardeningOptions) {
  const app = new Hono();
  installSecurityHeaders(app, opts);
  app.get("/probe", (c) => c.text("ok"));
  return app;
}

describe("installSecurityHeaders", () => {
  it("emits the hardened CSP including no-fallback directives", async () => {
    const res = await appWith().request("/probe");
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("ships the header defaults a baseline scan checks for", async () => {
    const res = await appWith().request("/probe");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe(
      "same-origin",
    );
    expect(res.headers.get("Strict-Transport-Security")).toContain(
      "max-age=",
    );
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("sets a deny-by-default Permissions-Policy", async () => {
    const res = await appWith().request("/probe");
    expect(res.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });

  it("leaves COEP unset unless opted in", async () => {
    const off = await appWith().request("/probe");
    expect(off.headers.get("Cross-Origin-Embedder-Policy")).toBeNull();
    const on = await appWith({ crossOriginEmbedderPolicy: true }).request(
      "/probe",
    );
    expect(on.headers.get("Cross-Origin-Embedder-Policy")).toBe(
      "require-corp",
    );
  });

  it("merges CSP overrides over the defaults", async () => {
    const res = await appWith({
      contentSecurityPolicy: { connectSrc: ["'self'"] },
    }).request("/probe");
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("sentry.io");
    // Untouched defaults survive the merge:
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("replaces the permissions policy when one is provided", async () => {
    const res = await appWith({
      permissionsPolicy: { camera: ["'self'"] },
    }).request("/probe");
    const pp = res.headers.get("Permissions-Policy");
    expect(pp).not.toBeNull();
    expect(pp).toContain("camera=(");
    expect(pp).not.toContain("geolocation");
  });

  it("exposes the defaults for inspection", () => {
    expect(DEFAULT_CSP.formAction).toEqual(["'self'"]);
    expect(DEFAULT_PERMISSIONS_POLICY).toEqual({
      camera: [],
      microphone: [],
      geolocation: [],
    });
  });
});