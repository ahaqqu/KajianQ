import type { ProviderConfig, VendorConfig } from "./provider-config";

/**
 * Shared provider test fixtures — vendor identity is data; tests use
 * synthetic names so the boundary gate's vendor rule can never fire on a
 * literal. `satisfies` keeps these structurally checked against the real
 * config types without erasing literal inference.
 */

export const testVendor = {
  baseUrl: "https://example.invalid/v1",
  apiKeyEnv: "TEST_KEY",
  protocol: "chat-completions",
  freeTier: true,
  personalDataAllowed: false,
  models: {
    "m-chat": {
      capabilities: ["generate", "stream"],
      priceMicroUsdPerMTok: { in: 500, out: 3000 },
    },
    "m-embed": {
      capabilities: ["embed"],
      dimensions: 8,
      priceMicroUsdPerMTok: { in: 100, out: 0 },
    },
  },
} satisfies VendorConfig;

export const altVendor = {
  ...testVendor,
  apiKeyEnv: "ALT_KEY",
  // The paid-tier alternative: personal data may route here (ADR-0009).
  personalDataAllowed: true,
  freeTier: false,
  models: {
    "alt-chat": {
      capabilities: ["generate", "stream"],
      priceMicroUsdPerMTok: { in: 140, out: 280 },
    },
  },
} satisfies VendorConfig;

export function configWith(chain: string[]): ProviderConfig {
  return {
    vendors: { test: testVendor, alt: altVendor },
    roles: { cheap: { chain } },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function chatBody(
  usage: { prompt_tokens: number; completion_tokens: number } = {
    prompt_tokens: 12,
    completion_tokens: 34,
  },
): unknown {
  return {
    choices: [{ message: { content: "hello there" } }],
    usage,
  };
}