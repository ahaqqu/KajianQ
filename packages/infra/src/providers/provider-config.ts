import * as v from "valibot";
import modelsJson from "./models.json";

/**
 * Provider config contract (ADR-0022). This schema is deliberately
 * vendor-name-free: vendor identity is data in `models.json`, never a literal
 * in TypeScript — the boundary gate proves it by scanning .ts and not .json.
 * The model ids, endpoints, and env names all arrive as config values.
 */

/** Price in micro-USD per million tokens, in and out. Integer arithmetic only. */
const PriceSchema = v.object({
  in: v.pipe(v.number(), v.integer(), v.minValue(0)),
  out: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const CapabilitiesSchema = v.array(v.picklist(["generate", "stream", "embed"]));

const ModelSchema = v.object({
  capabilities: CapabilitiesSchema,
  /** Output dimensions for embedding models (MRL truncation target). */
  dimensions: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  priceMicroUsdPerMTok: PriceSchema,
});

const VendorSchema = v.object({
  baseUrl: v.pipe(v.string(), v.url()),
  apiKeyEnv: v.pipe(v.string(), v.minLength(1)),
  protocol: v.picklist(["chat-completions"]),
  /** Free-tier traffic may be used for vendor training — personal data never routes here. */
  freeTier: v.boolean(),
  personalDataAllowed: v.boolean(),
  models: v.record(v.string(), ModelSchema),
});

export const ProviderConfigSchema = v.object({
  vendors: v.record(v.string(), VendorSchema),
  /** Role → ordered fallback chain of "vendor:model" candidate keys. */
  roles: v.record(v.string(), v.object({ chain: v.array(v.string()) })),
});

export type ProviderConfig = v.InferOutput<typeof ProviderConfigSchema>;
export type VendorConfig = v.InferOutput<typeof VendorSchema>;
export type ModelConfig = v.InferOutput<typeof ModelSchema>;

/** A parsed chain candidate: which vendor, which model entry. */
export type Candidate = {
  vendor: string;
  vendorConfig: VendorConfig;
  modelId: string;
  modelConfig: ModelConfig;
};

/**
 * Validate a raw provider config object. Throws on the first structural
 * problem (unknown protocol, bad URL, dangling chain candidate) — a wrong
 * config must fail at wiring time, never degrade to a silent default.
 */
export function parseProviderConfig(raw: unknown): ProviderConfig {
  const config = v.parse(ProviderConfigSchema, raw);

  // Cross-field validation the schema cannot express: every chain candidate
  // must reference an existing vendor model, and roles must not be empty.
  for (const [role, { chain }] of Object.entries(config.roles)) {
    if (chain.length === 0) {
      throw new Error(`provider config: role "${role}" has an empty chain`);
    }
    for (const candidate of chain) {
      const [vendor, modelId] = parseCandidateKey(candidate);
      const vendorConfig = config.vendors[vendor];
      if (!vendorConfig) {
        throw new Error(`provider config: role "${role}" references unknown vendor "${vendor}"`);
      }
      if (!vendorConfig.models[modelId]) {
        throw new Error(
          `provider config: role "${role}" references unknown model "${modelId}" on vendor "${vendor}"`,
        );
      }
    }
  }
  return config;
}

/** The checked-in provider config, validated once at first load (ADR-0022). */
export function loadProviderConfig(): ProviderConfig {
  return parseProviderConfig(modelsJson);
}

/** Split a "vendor:model" chain key. */
export function parseCandidateKey(key: string): [vendor: string, modelId: string] {
  const sep = key.indexOf(":");
  if (sep <= 0 || sep === key.length - 1) {
    throw new Error(`provider config: malformed candidate key "${key}" (expected "vendor:model")`);
  }
  return [key.slice(0, sep), key.slice(sep + 1)];
}

/**
 * Resolve a role's chain into parsed candidates, in order. Re-validates
 * candidate existence: unlike `parseProviderConfig`, this also serves
 * ad-hoc configs built in code (test fixtures, future programmatic
 * overrides) that never passed through load-time validation.
 */
export function resolveChain(config: ProviderConfig, role: string): Candidate[] {
  const roleEntry = config.roles[role];
  if (!roleEntry) {
    throw new Error(`provider config: unknown role "${role}"`);
  }
  return roleEntry.chain.map((key) => {
    const [vendor, modelId] = parseCandidateKey(key);
    const vendorConfig = config.vendors[vendor];
    const modelConfig = vendorConfig?.models[modelId];
    if (!vendorConfig || !modelConfig) {
      throw new Error(`provider config: unknown candidate "${key}"`);
    }
    return {
      vendor,
      vendorConfig,
      modelId,
      modelConfig,
    };
  });
}