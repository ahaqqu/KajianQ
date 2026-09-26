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

  it("passes through every key the chat path's provider roles resolve (#168)", async () => {
    // The silent-failure guard this test exists for: a key that is bound in
    // the serving environment but dropped by the composition root leaves its
    // role unwired while every other surface (models.json, the runbook, the
    // deploy env) says it is configured. The reviewer pre-gate is the sharpest
    // case — it is fail-open by design, so a dropped key degrades to "no
    // pre-gate" with no error anywhere. The env names are read from the
    // config data (ADR-0022), so a role added later is covered automatically.
    const { loadProviderConfig } = await import("@app/infra");
    const config = loadProviderConfig();
    const envNames = new Set<string>();
    for (const role of ["cheap", "generator", "reviewer", "embedder", "decision"]) {
      for (const candidate of config.roles[role]?.chain ?? []) {
        const vendor = candidate.slice(0, candidate.indexOf(":"));
        const name = config.vendors[vendor]?.apiKeyEnv;
        if (name !== undefined) envNames.add(name);
      }
    }
    expect(envNames.size).toBeGreaterThan(0);
    for (const name of envNames) {
      expect(bindingsFromEnv({ [name]: "test-key" }), `${name} is dropped`).toMatchObject({
        [name]: "test-key",
      });
    }
  });
});
