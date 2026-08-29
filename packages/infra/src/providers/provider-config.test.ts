import { describe, expect, it } from "vitest";
import {
  loadProviderConfig,
  parseCandidateKey,
  parseProviderConfig,
  resolveChain,
} from "./provider-config";
import { testVendor } from "./test-fixtures";

describe("provider config", () => {
  it("loads and validates the checked-in models.json", () => {
    const config = loadProviderConfig();
    // Role defaults from spec §3.4 exist as chains.
    expect(config.roles.generator?.chain.length).toBeGreaterThan(0);
    expect(config.roles.cheap?.chain.length).toBeGreaterThan(1);
    expect(config.roles.embedder?.chain.length).toBeGreaterThan(0);
    // Every chain candidate resolves to a real vendor+model.
    for (const { chain } of Object.values(config.roles)) {
      for (const key of chain) {
        const [vendor, modelId] = parseCandidateKey(key);
        const vendorConfig = config.vendors[vendor];
        expect(vendorConfig).toBeDefined();
        expect(vendorConfig?.models[modelId]).toBeDefined();
      }
    }
  });

  it("rejects a malformed or dangling config", () => {
    expect(() =>
      parseProviderConfig({
        vendors: { test: testVendor },
        roles: { cheap: { chain: ["test:no-such-model"] } },
      }),
    ).toThrow(/unknown model "no-such-model"/);
    expect(() =>
      parseProviderConfig({
        vendors: { test: testVendor },
        roles: { cheap: { chain: [] } },
      }),
    ).toThrow(/empty chain/);
    expect(() => parseCandidateKey("no-colon")).toThrow(/malformed candidate key/);
    expect(() => parseCandidateKey("vendoronly:")).toThrow(/malformed candidate key/);
  });

  it("resolveChain returns candidates in chain order", () => {
    const config = {
      vendors: {
        test: testVendor,
        alt: {
          ...testVendor,
          apiKeyEnv: "ALT_KEY",
          models: {
            "alt-chat": {
              capabilities: ["generate" as const, "stream" as const],
              priceMicroUsdPerMTok: { in: 140, out: 280 },
            },
          },
        },
      },
      roles: { cheap: { chain: ["test:m-chat", "alt:alt-chat"] } },
    };
    const chain = resolveChain(config, "cheap");
    expect(chain.map((c) => `${c.vendor}:${c.modelId}`)).toEqual([
      "test:m-chat",
      "alt:alt-chat",
    ]);
  });
});