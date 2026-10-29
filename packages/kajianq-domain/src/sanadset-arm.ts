/**
 * The adjudication arm: which provider, which model, what a call costs, and where the
 * credential comes from.
 *
 * A key never leaves `loadApiKey` and the client it builds: every other function here
 * returns booleans and prices, so a report, a log line or an artifact cannot carry the
 * credential by accident. Prices are list prices from the provider's published sheet;
 * a model with no price on file is refused rather than estimated, because a spend
 * figure with an invented price is worse than no figure.
 */

import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ProviderId = "dashscope" | "ollama";

export type ArmPrice = {
  /** USD per million input tokens. */
  readonly inputUsdPerMTok: number;
  /** USD per million output tokens. */
  readonly outputUsdPerMTok: number;
};

export type ProviderProfile = {
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly keyFileName: string;
  readonly defaultModel: string;
  readonly prices: Readonly<Record<string, ArmPrice>>;
};

/** Ollama Cloud's OpenAI-compatible surface and its owned-plan list prices. */
const OLLAMA_PROFILE: ProviderProfile = {
  baseUrl: "https://ollama.com/v1",
  apiKeyEnv: "OLLAMA_API_KEY",
  keyFileName: "ollama-key",
  defaultModel: "gemma4:31b",
  prices: {
    "gemma4:31b": { inputUsdPerMTok: 0.14, outputUsdPerMTok: 0.4 },
    "glm-5.3-flash": { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.5 },
    "deepseek-v4.1-flash": { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 },
  },
};

/** DashScope / Model Studio, international, OpenAI-compatible surface. */
const DASHSCOPE_PROFILE: ProviderProfile = {
  baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  apiKeyEnv: "DASHSCOPE_API_KEY",
  keyFileName: "dashscope-key",
  defaultModel: "qwen3.7-flash",
  prices: {
    "qwen3.7-flash": { inputUsdPerMTok: 0.03, outputUsdPerMTok: 0.13 },
    "qwen3.8-flash": { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.47 },
    "qwen3.7-plus": { inputUsdPerMTok: 0.276, outputUsdPerMTok: 1.101 },
  },
};

export const PROVIDER_PROFILES: Readonly<Record<ProviderId, ProviderProfile>> = {
  dashscope: DASHSCOPE_PROFILE,
  ollama: OLLAMA_PROFILE,
};

export type ArmDefinition = {
  readonly provider: ProviderId;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly keyFile: string;
  readonly price: ArmPrice;
};

export type ArmRequest = {
  readonly provider: ProviderId;
  readonly model?: string;
  readonly priceInUsdPerMTok?: number;
  readonly priceOutUsdPerMTok?: number;
  readonly baseUrl?: string;
};

function priceOverride(input: ArmRequest, profile: ProviderProfile, model: string): ArmPrice {
  if (input.priceInUsdPerMTok !== undefined || input.priceOutUsdPerMTok !== undefined) {
    const listed = profile.prices[model];
    const inputPrice = input.priceInUsdPerMTok ?? listed?.inputUsdPerMTok;
    const outputPrice = input.priceOutUsdPerMTok ?? listed?.outputUsdPerMTok;
    if (inputPrice === undefined || outputPrice === undefined) {
      throw new Error(`no price on file for ${input.provider}:${model}; pass both price overrides`);
    }
    return { inputUsdPerMTok: inputPrice, outputUsdPerMTok: outputPrice };
  }
  const listed = profile.prices[model];
  if (listed === undefined) {
    throw new Error(
      `no price on file for ${input.provider}:${model} — add it to the profile or pass --price-in/--price-out`,
    );
  }
  return listed;
}

/** Resolve a provider/model into a fully priced arm; an unpriced model throws. */
export function resolveArm(input: ArmRequest): ArmDefinition {
  const profile = PROVIDER_PROFILES[input.provider];
  const model = input.model ?? profile.defaultModel;
  return {
    provider: input.provider,
    baseUrl: input.baseUrl ?? profile.baseUrl,
    model,
    apiKeyEnv: profile.apiKeyEnv,
    keyFile: join(homedir(), ".config", "kajianq", profile.keyFileName),
    price: priceOverride(input, profile, model),
  };
}

export type ApiKey = { readonly value: string; readonly source: "env" | "file" };
export type ApiKeyLookup = { readonly key: ApiKey | null; readonly detail: string };

/**
 * Resolve the credential: environment first, then the machine-local key file. The
 * returned detail never contains the key, so it can be logged.
 */
export function loadApiKey(arm: ArmDefinition, env: NodeJS.ProcessEnv = process.env): ApiKeyLookup {
  const fromEnv = env[arm.apiKeyEnv];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return { key: { value: fromEnv.trim(), source: "env" }, detail: `${arm.apiKeyEnv} set` };
  }
  try {
    const fromFile = readFileSync(arm.keyFile, "utf8").trim();
    if (fromFile.length > 0)
      return { key: { value: fromFile, source: "file" }, detail: `${arm.keyFile} readable` };
    return { key: null, detail: `${arm.keyFile} is empty` };
  } catch {
    return { key: null, detail: `${arm.apiKeyEnv} unset and ${arm.keyFile} unreadable` };
  }
}

export type ArmStatus = {
  readonly provider: ProviderId;
  readonly baseUrl: string;
  readonly model: string;
  readonly keyPresent: boolean;
  readonly keySource: "env" | "file" | "absent";
  readonly keyDetail: string;
  readonly price: ArmPrice;
};

/** The key-free description of the arm that reports and logs may carry. */
export function describeArm(arm: ArmDefinition, lookup: ApiKeyLookup): ArmStatus {
  return {
    provider: arm.provider,
    baseUrl: arm.baseUrl,
    model: arm.model,
    keyPresent: lookup.key !== null,
    keySource: lookup.key?.source ?? "absent",
    keyDetail: lookup.detail,
    price: arm.price,
  };
}

/**
 * A prompt-token estimate from character count. Arabic tokenizes worse than English,
 * so the divisor is deliberately low: the estimate errs high rather than quoting a
 * spend figure the invoice will exceed. Every use is marked estimated, never metered.
 */
export const ESTIMATE_CHARS_PER_TOKEN = 3;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / ESTIMATE_CHARS_PER_TOKEN);
}

/** USD -> integer micro-USD, the unit every cost record and report carries. */
export function microUsd(tokensIn: number, tokensOut: number, price: ArmPrice): number {
  const usd =
    (tokensIn / 1_000_000) * price.inputUsdPerMTok +
    (tokensOut / 1_000_000) * price.outputUsdPerMTok;
  return Math.round(usd * 1_000_000);
}

export type ArmEstimate = {
  readonly calls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costMicroUsd: number;
  readonly estimated: true;
};

/** Price a set of planned calls without issuing any. */
export function estimateArm(
  price: ArmPrice,
  calls: readonly { readonly tokensIn: number; readonly tokensOut: number }[],
): ArmEstimate {
  let tokensIn = 0;
  let tokensOut = 0;
  for (const call of calls) {
    tokensIn += call.tokensIn;
    tokensOut += call.tokensOut;
  }
  return {
    calls: calls.length,
    tokensIn,
    tokensOut,
    costMicroUsd: microUsd(tokensIn, tokensOut, price),
    estimated: true,
  };
}
