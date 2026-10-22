import { describe, expect, it } from "vite-plus/test";
import {
  loadProviderConfig,
  ProviderConfigError,
  resolveChain,
  resolveRole,
  type ProviderConfig,
} from "@app/infra";
import { runFail } from "@app/rag-core/testing";
import { createProvidersFromEnv } from "./chat-wiring";

/**
 * The switchable provider profile (ADR-0059). The ticket's point is
 * **reversibility**, so the assertions here are exact rather than "still
 * contains": the default chain set is pinned byte-for-byte, the `ollama`
 * profile's four overrides are pinned, and the rollback test re-runs the same
 * default assertion with the profile unset.
 *
 * Vendor identity is named here because this is the product composition root's
 * test, the same place `personal-data-serving.test.ts` inspects the register's
 * machine-checkable shadow; the engine's own suites use synthetic vendors.
 */

/** The chains the checked-in config ships with no profile selected. */
const DEFAULT_CHAINS = {
  generator: ["deepseek:deepseek-v4-flash"],
  reviewer: ["deepseek:deepseek-v4-flash"],
  "reviewer-live": ["deepseek:deepseek-v4-flash"],
  cheap: ["deepseek:deepseek-v4-flash", "gemini:gemini-3-flash-preview"],
  translation: ["qwen:qwen3.7-max"],
  embedder: ["gemini-paid:gemini-embedding-001"],
  "embedder-candidates": ["gemini:gemini-embedding-001", "gemini:gemini-embedding-2"],
  "decision-candidates": ["typesafe:jev-1.13.0"],
  decision: ["typesafe:jev-1.13.0"],
} as const;

/** The four serving roles the `ollama` profile re-heads, and their replacement chains. */
const OLLAMA_CHAINS = {
  generator: ["ollama-cloud:deepseek-v4.1-flash"],
  reviewer: ["ollama-cloud:deepseek-v4.1-flash"],
  "reviewer-live": ["ollama-cloud:deepseek-v4.1-flash"],
  cheap: ["ollama-cloud:deepseek-v4.1-flash", "gemini:gemini-3-flash-preview"],
} as const;

const PROMPT = { turns: [{ role: "user", content: "hi" }] };

/** The chains a config exposes, as the exact data the assertion compares. */
function chains(config: ProviderConfig): Record<string, readonly string[]> {
  return Object.fromEntries(Object.entries(config.roles).map(([role, { chain }]) => [role, chain]));
}

describe("provider profile — default is byte-identical to today's chains", () => {
  it("resolves the checked-in chains exactly when no profile is selected", () => {
    expect(chains(loadProviderConfig())).toEqual(DEFAULT_CHAINS);
  });

  it("treats the explicit `default` profile as the same chain set", () => {
    expect(chains(loadProviderConfig("default"))).toEqual(DEFAULT_CHAINS);
  });
});

describe("provider profile — `ollama` re-heads exactly the serving roles", () => {
  it("overrides the four chat roles and leaves every other chain untouched", () => {
    expect(chains(loadProviderConfig("ollama"))).toEqual({
      ...DEFAULT_CHAINS,
      ...OLLAMA_CHAINS,
    });
  });

  it("is selected from the env record at wiring time", () => {
    const switched = createProvidersFromEnv({
      PROVIDER_PROFILE: "ollama",
      OLLAMA_API_KEY: "sk-ollama",
    });
    expect(switched.generator.modelId).toBe("deepseek-v4.1-flash");
    expect(switched.reviewer?.modelId).toBe("deepseek-v4.1-flash");
    // The cheap chain's head is switched too; the free-tier tail stays in the
    // chain so the personal-data filter's trap case remains wired.
    expect(switched.router.modelId).toBe("deepseek-v4.1-flash");

    const rolledBack = createProvidersFromEnv({ DEEPSEEK_API_KEY: "sk-deepseek" });
    expect(rolledBack.generator.modelId).toBe("deepseek-v4-flash");
    expect(rolledBack.reviewer?.modelId).toBe("deepseek-v4-flash");
  });
});

describe("provider profile — an unknown name is a typed config failure", () => {
  it("rejects an undeclared profile instead of falling back to the default chains", () => {
    let thrown: unknown;
    try {
      loadProviderConfig("olama");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProviderConfigError);
    const error = thrown as ProviderConfigError;
    expect(error.message).toContain('unknown PROVIDER_PROFILE "olama"');
    expect(error.message).toContain("default, ollama");

    // The same failure at the composition root: the wiring never silently
    // serves the default vendor when the deployment asked for another profile.
    expect(() => createProvidersFromEnv({ PROVIDER_PROFILE: "olama" })).toThrow(
      ProviderConfigError,
    );
  });
});

describe("provider profile — resolveRole under `ollama`", () => {
  const config = loadProviderConfig("ollama");

  it("with the key present: wires the ollama candidate, and only it", () => {
    const { provider, missingKeys } = resolveRole(config, "generator", {
      env: { OLLAMA_API_KEY: "sk-ollama" },
    });
    expect(missingKeys).toEqual([]);
    expect(provider.modelId).toBe("deepseek-v4.1-flash");
    // The selected chain contains no other vendor, so a failure cannot walk on
    // to DeepSeek — that is the difference between a switch and a fallback.
    expect(resolveChain(config, "generator").map((c) => `${c.vendor}:${c.modelId}`)).toEqual([
      "ollama-cloud:deepseek-v4.1-flash",
    ]);
    // The trace identity and cost basis a switched call records come from this
    // row: the model id above, priced at the vendor's published peak rate.
    const row = config.vendors["ollama-cloud"];
    expect(row?.baseUrl).toBe("https://ollama.com/v1");
    expect(row?.apiKeyEnv).toBe("OLLAMA_API_KEY");
    expect(row?.protocol).toBe("chat-completions");
    expect(row?.models["deepseek-v4.1-flash"]?.priceMicroUsdPerMTok).toEqual({
      in: 300000,
      out: 1200000,
    });
  });

  it("with the key absent: fails typed naming OLLAMA_API_KEY, never DeepSeek", async () => {
    // The DeepSeek key is bound and still must not be reached: the selected
    // profile's chain does not contain a DeepSeek candidate, and no implicit
    // fallback is added on a missing key.
    const { provider, missingKeys } = resolveRole(config, "generator", {
      env: { DEEPSEEK_API_KEY: "sk-deepseek" },
    });
    expect(missingKeys).toEqual(["OLLAMA_API_KEY"]);
    // No wired candidate — the provider's modelId falls back to the role name
    // rather than pretending a vendor is wired.
    expect(provider.modelId).toBe("generator");

    const err = await runFail(provider.generate(PROMPT));
    expect(err.kind).toBe("bad_request");
    expect(err.message).toContain("OLLAMA_API_KEY");
    expect(err.message).not.toContain("DEEPSEEK_API_KEY");
  });
});

describe("provider profile — rollback", () => {
  it("unsetting the profile restores today's chains exactly", () => {
    // The same assertion as the first test: unset is the rollback, and it needs
    // no JSON edit and no revert commit.
    expect(chains(loadProviderConfig(undefined))).toEqual(DEFAULT_CHAINS);
    // An empty env value is "unset" too (a systemd `PROVIDER_PROFILE=` line).
    expect(chains(loadProviderConfig(""))).toEqual(DEFAULT_CHAINS);
  });
});
