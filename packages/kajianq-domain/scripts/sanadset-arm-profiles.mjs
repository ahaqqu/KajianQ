/**
 * The study's arm profiles: which providers a run may name, at which endpoint, with which
 * pilot model, and at which published list price.
 *
 * These values live here — in the CLI, the composition root — and not in the domain
 * package. The package ships the shape (`sanadset-arm.ts`) and receives a resolved
 * `ArmDefinition`; a library module that hardcodes an endpoint, a model id or a price
 * cannot be re-pointed without a code change, and pluggability (ADR-0009) puts vendor data
 * in configuration. The canonical serving sheet is
 * `packages/infra/src/providers/models.json`; this study's two pilot models are not in
 * that mirror, and a research run's arm is its own config knob, so the price sheet is
 * stated here and reviewed like any model decision.
 *
 * Prices are USD per million tokens, the unit `ArmPrice` uses. A model with no price on
 * file is refused rather than estimated.
 */
export const ARM_PROFILES = {
  dashscope: {
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    keyFileName: "dashscope-key",
    defaultModel: "qwen3.7-flash",
    prices: {
      "qwen3.7-flash": { inputUsdPerMTok: 0.03, outputUsdPerMTok: 0.13 },
      "qwen3.8-flash": { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.47 },
      "qwen3.7-plus": { inputUsdPerMTok: 0.276, outputUsdPerMTok: 1.101 },
    },
  },
  ollama: {
    baseUrl: "https://ollama.com/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    keyFileName: "ollama-key",
    defaultModel: "gemma4:31b",
    prices: {
      "gemma4:31b": { inputUsdPerMTok: 0.14, outputUsdPerMTok: 0.4 },
      "glm-5.3-flash": { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.5 },
      "deepseek-v4.1-flash": { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 },
    },
  },
};
