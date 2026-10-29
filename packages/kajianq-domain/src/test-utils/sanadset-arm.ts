import type { ArmResolverConfig } from "../sanadset-arm";

/**
 * Test-only arm configuration.
 *
 * The library under test carries no vendor data, so a test that wants a priced arm has to
 * supply the profiles — exactly as the CLI's composition root does. These are fixtures,
 * not the study's real endpoints or prices: the values a run uses live in
 * `scripts/sanadset-arm-profiles.mjs`.
 */
export const TEST_ARM_CONFIG: ArmResolverConfig = {
  homeDir: "/test-home",
  profiles: {
    dashscope: {
      baseUrl: "https://dashscope.test/v1",
      apiKeyEnv: "TEST_KEY_ENV",
      keyFileName: "dashscope-key",
      defaultModel: "qwen-test",
      prices: { "qwen-test": { inputUsdPerMTok: 0.03, outputUsdPerMTok: 0.13 } },
    },
    ollama: {
      baseUrl: "https://ollama.test/v1",
      apiKeyEnv: "TEST_OLLAMA_KEY",
      keyFileName: "ollama-key",
      defaultModel: "gemma-test",
      prices: { "gemma-test": { inputUsdPerMTok: 0.14, outputUsdPerMTok: 0.4 } },
    },
  },
};
