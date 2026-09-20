import { describe, expect, it } from "vitest";
import { bindingsFromEnv } from "./server";

/**
 * The Bun serving entry's env→bindings mapping (#181, ADR-0044). This is the
 * composition root, so it is the one place a process environment is read; the
 * assertions pin the two behaviors that matter for a self-hosted host:
 * present keys are copied, and an ABSENT key stays absent (the "feature
 * disabled" posture — a role with no keyed candidate fails with a clear error,
 * rather than being handed an empty string that looks configured).
 */

describe("bindingsFromEnv", () => {
  it("copies every present key onto the bindings", () => {
    const bindings = bindingsFromEnv({
      APP_ENV: "production",
      DATABASE_URL: "postgres://u:p@127.0.0.1:5432/kajianq",
      DEEPSEEK_API_KEY: "sk-deepseek",
      SENTRY_DSN: "https://key@o0.ingest.sentry.io/1",
      GEMINI_PAID_API_KEY: "sk-gemini-paid",
    });
    expect(bindings.APP_ENV).toBe("production");
    expect(bindings.DATABASE_URL).toBe("postgres://u:p@127.0.0.1:5432/kajianq");
    expect(bindings.DEEPSEEK_API_KEY).toBe("sk-deepseek");
    expect(bindings.SENTRY_DSN).toBe("https://key@o0.ingest.sentry.io/1");
    expect(bindings.GEMINI_PAID_API_KEY).toBe("sk-gemini-paid");
  });

  it("omits an absent key rather than binding an empty string", () => {
    const bindings = bindingsFromEnv({ APP_ENV: "staging" });
    expect("DEEPSEEK_API_KEY" in bindings).toBe(false);
    expect("DATABASE_URL" in bindings).toBe(false);
    expect(bindings.APP_ENV).toBe("staging");
  });

  it("treats an empty value as absent", () => {
    // A systemd EnvironmentFile line like `DEEPSEEK_API_KEY=` yields an empty
    // string; that must mean "not configured", not "configured as nothing".
    const bindings = bindingsFromEnv({ DEEPSEEK_API_KEY: "" });
    expect("DEEPSEEK_API_KEY" in bindings).toBe(false);
  });

  it("always supplies an ASSETS handle (the SPA catch-all needs one)", () => {
    const bindings = bindingsFromEnv({});
    expect(typeof bindings.ASSETS.fetch).toBe("function");
  });
});
