import { describe, expect, it } from "vite-plus/test";
import { resolveDecider } from "./decider-resolve";
import type { ProviderConfig } from "./provider-config";

/**
 * The decision seam's protocol dispatch: each declared wire constructs its
 * own adapter, and a protocol with no wire fails loudly instead of falling
 * back to another wire and being scored as if it spoke that one.
 */

const MODEL = { capabilities: ["decide"], priceMicroUsdPerMTok: { in: 1000, out: 0 } };

function configFor(protocol: string): ProviderConfig {
  return {
    vendors: {
      vendor: {
        baseUrl: "https://vendor.invalid/api",
        apiKeyEnv: "VENDOR_KEY",
        protocol,
        freeTier: false,
        personalDataAllowed: true,
        models: { "m-latest": MODEL },
      },
    },
    roles: { decision: { chain: ["vendor:m-latest"] } },
  } as unknown as ProviderConfig;
}

describe("resolveDecider — protocol dispatch", () => {
  it("wires each declared protocol to its own adapter", () => {
    for (const protocol of ["chat-completions", "decisions"] as const) {
      const { deciders, missingKeys } = resolveDecider(configFor(protocol), "decision", {
        env: { VENDOR_KEY: "sk-test" },
      });
      expect(missingKeys).toEqual([]);
      expect(deciders.map((d) => d.decider.modelId)).toEqual(["m-latest"]);
    }
  });

  it("refuses a protocol it has no wire for instead of defaulting", () => {
    expect(() =>
      resolveDecider(configFor("grpc"), "decision", { env: { VENDOR_KEY: "sk-test" } }),
    ).toThrow(/unsupported decide protocol "grpc"/);
  });
});
