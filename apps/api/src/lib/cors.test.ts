import { describe, expect, it } from "vitest";
import { resolveCorsOrigin } from "./cors";

const ALLOWLIST = ["http://localhost:8787", "https://app.example"];

describe("resolveCorsOrigin", () => {
  it("falls back to the first allowlisted origin when no Origin header", () => {
    expect(resolveCorsOrigin(undefined, "https://api.example/v1/health", ALLOWLIST))
      .toBe("http://localhost:8787");
  });

  it("falls back to * when the allowlist is empty", () => {
    expect(resolveCorsOrigin(undefined, "https://api.example/v1/health", []))
      .toBe("*");
  });

  it("echoes an allowlisted origin", () => {
    expect(
      resolveCorsOrigin("https://app.example", "https://api.example/v1/health", ALLOWLIST),
    ).toBe("https://app.example");
  });

  it("echoes the worker's own host (SPA + API same origin)", () => {
    expect(
      resolveCorsOrigin("https://api.example", "https://api.example/v1/health", ALLOWLIST),
    ).toBe("https://api.example");
  });

  it("rejects a disallowed origin", () => {
    expect(
      resolveCorsOrigin("https://evil.example", "https://api.example/v1/health", ALLOWLIST),
    ).toBe("");
  });

  it("rejects when the request URL is malformed", () => {
    expect(resolveCorsOrigin("https://evil.example", "not a url", ALLOWLIST))
      .toBe("");
  });
});
