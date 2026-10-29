/**
 * The shape of the adjudication arm: what a provider profile configures, what a request
 * resolves to, and how a credential is looked up.
 *
 * This module holds the **shape, not the values**. Endpoints, model ids, list prices and
 * credential locations are configuration, and configuration arrives from the composition
 * root (`scripts/sanadset-study.mjs` and the arm profile module it owns) — the library
 * never names a vendor, never carries a price and never reads `process.env` or the home
 * directory. That is the pluggability rule for model choice: swapping a provider or a
 * pilot model changes the CLI's config, not this package.
 *
 * A key never leaves `loadApiKey` and the client it builds: every other function here
 * returns booleans and prices, so a report, a log line or an artifact cannot carry the
 * credential by accident. Prices are list prices from the provider's published sheet; a
 * model with no price on file is refused rather than estimated, because a spend figure
 * with an invented price is worse than no figure.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ArmPrice = {
  /** USD per million input tokens. */
  readonly inputUsdPerMTok: number;
  /** USD per million output tokens. */
  readonly outputUsdPerMTok: number;
};

/** One provider's configuration: endpoint, credential location, default model, list prices. */
export type ProviderProfile = {
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly keyFileName: string;
  readonly defaultModel: string;
  readonly prices: Readonly<Record<string, ArmPrice>>;
};

/** The provider profiles the composition root injects, keyed by the id a run may request. */
export type ArmProfiles = Readonly<Record<string, ProviderProfile>>;

export type ArmDefinition = {
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly keyFile: string;
  readonly price: ArmPrice;
};

export type ArmRequest = {
  readonly provider: string;
  readonly model?: string;
  readonly priceInUsdPerMTok?: number;
  readonly priceOutUsdPerMTok?: number;
  readonly baseUrl?: string;
};

/** Where the profiles and the home directory a key file is resolved under come from. */
export type ArmResolverConfig = {
  readonly profiles: ArmProfiles;
  readonly homeDir: string;
};

function priceOverride(input: ArmRequest, profile: ProviderProfile, model: string): ArmPrice {
  const listed = profile.prices[model];
  if (input.priceInUsdPerMTok !== undefined || input.priceOutUsdPerMTok !== undefined) {
    const inputPrice = input.priceInUsdPerMTok ?? listed?.inputUsdPerMTok;
    const outputPrice = input.priceOutUsdPerMTok ?? listed?.outputUsdPerMTok;
    if (inputPrice === undefined || outputPrice === undefined) {
      throw new Error(`no price on file for ${input.provider}:${model}; pass both price overrides`);
    }
    return { inputUsdPerMTok: inputPrice, outputUsdPerMTok: outputPrice };
  }
  if (listed === undefined) {
    throw new Error(
      `no price on file for ${input.provider}:${model} — add it to the profile or pass --price-in/--price-out`,
    );
  }
  return listed;
}

/** Resolve a provider/model into a fully priced arm; an unpriced model throws. */
export function resolveArm(input: ArmRequest, config: ArmResolverConfig): ArmDefinition {
  const profile = config.profiles[input.provider];
  if (profile === undefined) {
    const known = Object.keys(config.profiles).sort().join(", ");
    throw new Error(`unknown provider "${input.provider}"; configured providers: ${known}`);
  }
  const model = input.model ?? profile.defaultModel;
  return {
    provider: input.provider,
    baseUrl: input.baseUrl ?? profile.baseUrl,
    model,
    apiKeyEnv: profile.apiKeyEnv,
    keyFile: join(config.homeDir, ".config", "kajianq", profile.keyFileName),
    price: priceOverride(input, profile, model),
  };
}

export type ApiKey = { readonly value: string; readonly source: "env" | "file" };
export type ApiKeyLookup = { readonly key: ApiKey | null; readonly detail: string };

/**
 * Resolve the credential: environment first, then the machine-local key file. The
 * returned detail never contains the key, so it can be logged. The environment is an
 * argument, not `process.env`: a library that reads the process environment cannot be
 * exercised without the machine's real configuration.
 */
export function loadApiKey(
  arm: ArmDefinition,
  env: Readonly<Record<string, string | undefined>>,
): ApiKeyLookup {
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
  readonly provider: string;
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
