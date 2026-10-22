import * as v from "valibot";
import modelsJson from "./models.json";

/**
 * Provider config contract (ADR-0022, ADR-0059). This schema is deliberately
 * vendor-name-free: vendor identity is data in `models.json`, never a literal
 * in TypeScript — the boundary gate proves it by scanning .ts and not .json.
 * The model ids, endpoints, env names and profile names all arrive as config
 * values.
 */

/**
 * A config fault discovered at wiring time: a malformed chain, a dangling
 * candidate, or an unknown profile. Typed so the composition root can tell
 * "this deployment is misconfigured" from a code defect; no config fault
 * degrades to a silent default.
 */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

const PriceSchema = v.object({
  in: v.pipe(v.number(), v.integer(), v.minValue(0)),
  out: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const CapabilitiesSchema = v.array(v.picklist(["generate", "stream", "embed", "decide"]));

const ModelSchema = v.object({
  capabilities: CapabilitiesSchema,
  /** Output dimensions for embedding models (MRL truncation target). */
  dimensions: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  priceMicroUsdPerMTok: PriceSchema,
});

const VendorSchema = v.object({
  baseUrl: v.pipe(v.string(), v.url()),
  apiKeyEnv: v.pipe(v.string(), v.minLength(1)),
  protocol: v.picklist(["chat-completions", "systemone"]),
  /** Free-tier traffic may be used for vendor training — personal data never routes here. */
  freeTier: v.boolean(),
  personalDataAllowed: v.boolean(),
  models: v.record(v.string(), ModelSchema),
});

/**
 * A named role-chain override set: the profile name selects it, and each entry
 * replaces one declared role's chain. A profile may not invent a role, and its
 * candidates are validated exactly like the base chains.
 */
const ProfilesSchema = v.record(v.string(), v.record(v.string(), v.array(v.string())));

export const ProviderConfigSchema = v.object({
  vendors: v.record(v.string(), VendorSchema),
  /** Role → ordered fallback chain of "vendor:model" candidate keys. */
  roles: v.record(v.string(), v.object({ chain: v.array(v.string()) })),
  /** Named override sets selected by `PROVIDER_PROFILE`; the default profile is `roles`. */
  profiles: v.optional(ProfilesSchema),
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

/** Split a "vendor:model" chain key. */
export function parseCandidateKey(key: string): [vendor: string, modelId: string] {
  const sep = key.indexOf(":");
  if (sep <= 0 || sep === key.length - 1) {
    throw new ProviderConfigError(
      `provider config: malformed candidate key "${key}" (expected "vendor:model")`,
    );
  }
  return [key.slice(0, sep), key.slice(sep + 1)];
}

/** Cross-field validation the schema cannot express: every chain candidate must
 * reference an existing vendor model, and no chain may be empty. */
function assertChainResolvable(
  config: ProviderConfig,
  label: string,
  chain: readonly string[],
): void {
  if (chain.length === 0) {
    throw new ProviderConfigError(`provider config: ${label} has an empty chain`);
  }
  for (const candidate of chain) {
    const [vendor, modelId] = parseCandidateKey(candidate);
    const vendorConfig = config.vendors[vendor];
    if (!vendorConfig) {
      throw new ProviderConfigError(
        `provider config: ${label} references unknown vendor "${vendor}"`,
      );
    }
    if (!vendorConfig.models[modelId]) {
      throw new ProviderConfigError(
        `provider config: ${label} references unknown model "${modelId}" on vendor "${vendor}"`,
      );
    }
  }
}

/**
 * Validate a raw provider config object. Throws on the first structural
 * problem (unknown protocol, bad URL, dangling chain candidate, an override of
 * a role that does not exist) — a wrong config must fail at wiring time, never
 * degrade to a silent default.
 */
export function parseProviderConfig(raw: unknown): ProviderConfig {
  const config = v.parse(ProviderConfigSchema, raw);

  for (const [role, { chain }] of Object.entries(config.roles)) {
    assertChainResolvable(config, `role "${role}"`, chain);
  }
  for (const [profile, overrides] of Object.entries(config.profiles ?? {})) {
    for (const [role, chain] of Object.entries(overrides)) {
      if (!(role in config.roles)) {
        throw new ProviderConfigError(
          `provider config: profile "${profile}" overrides unknown role "${role}"`,
        );
      }
      assertChainResolvable(config, `profile "${profile}" role "${role}"`, chain);
    }
  }
  return config;
}

/** The implicit profile: the `roles` block exactly, with no overrides. */
export const DEFAULT_PROFILE = "default";

let checkedIn: ProviderConfig | undefined;
const profileCache = new Map<string, ProviderConfig>();

/** The checked-in config, validated once per process (ADR-0022). */
function checkedInConfig(): ProviderConfig {
  checkedIn ??= parseProviderConfig(modelsJson);
  return checkedIn;
}

/**
 * Apply a profile's overrides to the base config. The default profile is the
 * base config itself, so `default` and an absent selection are the same chain
 * set; a name the config does not declare throws a `ProviderConfigError`
 * listing the known profiles.
 */
function applyProfile(config: ProviderConfig, profile: string): ProviderConfig {
  if (profile === DEFAULT_PROFILE) return config;
  const overrides = config.profiles?.[profile];
  if (!overrides) {
    const known = [...new Set([DEFAULT_PROFILE, ...Object.keys(config.profiles ?? {})])];
    throw new ProviderConfigError(
      `provider config: unknown PROVIDER_PROFILE "${profile}" (known: ${known.join(", ")})`,
    );
  }
  const roles = { ...config.roles };
  for (const [role, chain] of Object.entries(overrides)) {
    roles[role] = { chain: [...chain] };
  }
  return { ...config, roles };
}

/**
 * The checked-in provider config with the selected profile's overrides
 * applied (ADR-0059). `profile` is the deployment's `PROVIDER_PROFILE`: absent
 * or empty selects the default chains, so the rollback is unsetting the
 * variable. An unknown profile is a `ProviderConfigError` naming it — never a
 * silent fall back to the default.
 *
 * The config is immutable for the process's lifetime, so the parse is cached
 * per profile; an unknown profile throws on every call and is never cached.
 */
export function loadProviderConfig(profile: string = DEFAULT_PROFILE): ProviderConfig {
  const selected = profile.trim() === "" ? DEFAULT_PROFILE : profile.trim();
  const cached = profileCache.get(selected);
  if (cached) return cached;
  const config = applyProfile(checkedInConfig(), selected);
  profileCache.set(selected, config);
  return config;
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
    throw new ProviderConfigError(`provider config: unknown role "${role}"`);
  }
  return roleEntry.chain.map((key) => {
    const [vendor, modelId] = parseCandidateKey(key);
    const vendorConfig = config.vendors[vendor];
    const modelConfig = vendorConfig?.models[modelId];
    if (!vendorConfig || !modelConfig) {
      throw new ProviderConfigError(`provider config: unknown candidate "${key}"`);
    }
    return {
      vendor,
      vendorConfig,
      modelId,
      modelConfig,
    };
  });
}
