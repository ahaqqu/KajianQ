import { describe, expect, it, vi } from "vitest";
import { createLogger, type ProviderConfig } from "@app/infra";
import { CHAT_SERVING_ROLES, createProvidersFromEnv } from "./chat-wiring";
import { bindingsFromEnv, reportProviderPosture, serveApi } from "./server";

/** The serving entry's env→bindings mapping: present keys are copied, an ABSENT key
 * stays absent — the "feature disabled" posture, where a role with no keyed candidate
 * fails with a clear error rather than being handed an empty string that looks
 * configured. */

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
    // The silent-failure guard: a key bound in the serving environment but dropped
    // here leaves its role unwired while every other surface says it is configured
    // (the fail-open reviewer pre-gate silently degrades to "no pre-gate"). Env names
    // come from the config data and roles from the wiring's own `CHAT_SERVING_ROLES`.
    const { loadProviderConfig } = await import("@app/infra");
    const config = loadProviderConfig();
    const envNames = new Set<string>();
    for (const role of CHAT_SERVING_ROLES) {
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

/** The startup provider-posture report: which env vars the chat path found absent and
 * which decision candidates the personal-data posture dropped, pinning both serving
 * postures, the ineligible case, and that the report names env vars, never values. */
describe("reportProviderPosture — the boot ops report (#226)", () => {
  // A value no log line may ever contain; distinctive so a match cannot pass by chance.
  const SECRET = "sk-live-DO-NOT-LEAK-226";

  /** Run the boot report through the real logger and capture its JSON lines. */
  function emit(providers: Parameters<typeof reportProviderPosture>[0]) {
    const lines: string[] = [];
    reportProviderPosture(
      providers,
      createLogger({ service: "api", route: "bootstrap" }, (line) => lines.push(line)),
    );
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed["msg"]).toBe("providers.posture");
    return { lines: lines.join("\n"), fields: parsed };
  }

  /** The decision role's key env name, read from the config (never hard-coded). */
  async function decisionKeyEnv(): Promise<string> {
    const { loadProviderConfig } = await import("@app/infra");
    const config = loadProviderConfig();
    const [vendor = ""] = (config.roles.decision?.chain[0] ?? "").split(":");
    const name = config.vendors[vendor]?.apiKeyEnv;
    expect(name).toBeDefined();
    return name as string;
  }

  it("names an absent decision key and states the pre-gate is not wired", async () => {
    const key = await decisionKeyEnv();
    // Every other key is bound (and secret); only the optional decision key is absent.
    // The report must name the var to bind and state the pre-gate is not wired.
    const { lines, fields } = emit(
      createProvidersFromEnv({ GEMINI_PAID_API_KEY: SECRET, DEEPSEEK_API_KEY: SECRET }),
    );
    expect(fields["preGate"]).toBe("not_wired");
    expect(String(fields["missingKeys"])).toContain(key);
    expect(fields["ineligibleKeys"]).toBe("none");
    expect(lines).not.toContain(SECRET);
  });

  it("reports the active posture when the decision key is bound", async () => {
    const key = await decisionKeyEnv();
    const { lines, fields } = emit(
      createProvidersFromEnv({
        GEMINI_PAID_API_KEY: SECRET,
        DEEPSEEK_API_KEY: SECRET,
        [key]: SECRET,
      }),
    );
    expect(fields["preGate"]).toBe("active");
    expect(String(fields["missingKeys"])).not.toContain(key);
    expect(lines).not.toContain(SECRET);
  });

  it("names a keyed candidate the personal-data posture dropped", () => {
    // No ineligible decision candidate ships, so the drop is driven through a synthetic
    // config on the real `createProvidersFromEnv` path. A keyed free-tier decision vendor
    // must never carry the pre-gate's claim spans: report it in `ineligibleKeys`.
    const synthetic: ProviderConfig = {
      vendors: {
        chatpaid: {
          baseUrl: "https://example.invalid/v1",
          apiKeyEnv: "CHAT_KEY",
          protocol: "chat-completions",
          freeTier: false,
          personalDataAllowed: true,
          models: {
            "m-chat": {
              capabilities: ["generate", "stream", "embed"],
              priceMicroUsdPerMTok: { in: 1, out: 1 },
            },
          },
        },
        free: {
          baseUrl: "https://example.invalid/v1",
          apiKeyEnv: "FREE_KEY",
          protocol: "systemone",
          freeTier: true,
          personalDataAllowed: false,
          models: {
            "m-decide": { capabilities: ["decide"], priceMicroUsdPerMTok: { in: 42, out: 0 } },
          },
        },
        decpaid: {
          baseUrl: "https://example.invalid/v1",
          apiKeyEnv: "DEC_KEY",
          protocol: "systemone",
          freeTier: false,
          personalDataAllowed: true,
          models: {
            "m-decide": { capabilities: ["decide"], priceMicroUsdPerMTok: { in: 42, out: 0 } },
          },
        },
      },
      roles: {
        cheap: { chain: ["chatpaid:m-chat"] },
        generator: { chain: ["chatpaid:m-chat"] },
        reviewer: { chain: ["chatpaid:m-chat"] },
        embedder: { chain: ["chatpaid:m-chat"] },
        decision: { chain: ["free:m-decide", "decpaid:m-decide"] },
      },
    };
    const { lines, fields } = emit(
      createProvidersFromEnv({ CHAT_KEY: SECRET, FREE_KEY: SECRET, DEC_KEY: SECRET }, synthetic),
    );
    expect(fields["preGate"]).toBe("active");
    expect(fields["missingKeys"]).toBe("none");
    expect(fields["ineligibleKeys"]).toBe("FREE_KEY");
    expect(lines).not.toContain(SECRET);
  });

  it("prints env names only — never a key's value, on any posture", async () => {
    const key = await decisionKeyEnv();
    // Fully bound: both surfaces are empty, and the report must still not echo a value.
    const { lines, fields } = emit(
      createProvidersFromEnv({
        GEMINI_API_KEY: SECRET,
        GEMINI_PAID_API_KEY: SECRET,
        DASHSCOPE_API_KEY: SECRET,
        DEEPSEEK_API_KEY: SECRET,
        [key]: SECRET,
      }),
    );
    // Load-bearing: an unkeyed chat-role candidate in the checked-in config must fail
    // this test rather than silently weaken the posture it claims.
    expect(fields["missingKeys"]).toBe("none");
    expect(fields["ineligibleKeys"]).toBe("none");
    expect(lines).not.toContain(SECRET);
    expect(JSON.stringify(fields)).not.toContain(SECRET);
  });

  it("is emitted exactly once by serveApi at boot, before the listening line", async () => {
    // Drives the real `serveApi` with a stubbed `Bun.serve` (the test runtime is Node)
    // and captures the boot logger's stdout, so deleting the call is a red test.
    const key = await decisionKeyEnv();
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    const serve = vi.fn(() => ({ stop: async () => {} }));
    const globals = globalThis as { Bun?: unknown };
    const previousBun = globals.Bun;
    globals.Bun = { serve };
    try {
      const { stop } = serveApi({
        api: { fetch: () => new Response("ok") } as unknown as Parameters<
          typeof serveApi
        >[0]["api"],
        hostname: "127.0.0.1",
        port: 0,
        env: { GEMINI_PAID_API_KEY: SECRET, DEEPSEEK_API_KEY: SECRET },
      });
      expect(serve).toHaveBeenCalledTimes(1);
      await stop();
    } finally {
      globals.Bun = previousBun;
      spy.mockRestore();
    }

    const postureLines = logged.filter((line) => line.includes("providers.posture"));
    expect(postureLines).toHaveLength(1);
    expect(logged[0]).toContain("providers.posture");
    expect(postureLines[0]).toContain('"preGate":"not_wired"');
    expect(postureLines[0]).toContain(key);
    expect(logged.join("\n")).not.toContain(SECRET);
  });
});
