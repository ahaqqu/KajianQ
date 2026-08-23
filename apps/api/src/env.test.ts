import { describe, expect, it } from "vitest";
import { allowedOrigins, resolveEnvName } from "./env";

describe("resolveEnvName", () => {
  it("maps known values", () => {
    expect(resolveEnvName("staging")).toBe("staging");
    expect(resolveEnvName("production")).toBe("production");
  });

  it("defaults unknown to development", () => {
    expect(resolveEnvName(undefined)).toBe("development");
  });
});

describe("allowedOrigins", () => {
  it("parses CSV", () => {
    expect(allowedOrigins("https://a.com, https://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("returns an empty allowlist when unset or blank", () => {
    expect(allowedOrigins(undefined)).toEqual([]);
    expect(allowedOrigins("")).toEqual([]);
    expect(allowedOrigins("   ")).toEqual([]);
  });
});
