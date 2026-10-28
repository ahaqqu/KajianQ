import type { ModelConfigEntry, ModelConfigRecord } from "../rag-store-model-config-seam";
import {
  parseCandidateKey,
  ProviderConfigError,
  type ModelConfig,
  type ProviderConfig,
  type VendorConfig,
} from "./provider-config";

/**
 * The `model_configs` mirror's derivation and drift check (ADR-0022 decision 3).
 *
 * The provider config file is the source of truth; the mirror is derived, never
 * written by hand. Two facts hold the derivation honest:
 *
 *  - **The effective config is the input.** A role chain is resolved against the
 *    deployment's profile before this module sees it, so a profile-switched
 *    deployment mirrors the models that can actually serve, not the default chains.
 *  - **A dangling candidate is a typed fault, not a skipped row.** `parseCandidateKey`
 *    and the vendor/model lookups throw a `ProviderConfigError`; a chain naming a
 *    provider or model the config does not declare produces no mirror at all rather
 *    than a partially derived one that would read as current.
 *
 * The payload is the model config's own data: capabilities, dimensions, the price in
 * micro-USD per MTok, and the vendor terms. The drift check compares it canonically
 * (object key order is not part of the value), so a price or terms edit that was not
 * pushed through `syncModelConfigs` is visible as drift, never as a stale admin read.
 */

/** One drift finding, keyed `role\0provider\0modelId` so two rows can never collide. */
export type ModelConfigDrift = {
  /** Config entries with no mirror row. */
  missing: readonly string[];
  /** Mirror rows the config does not name. */
  unexpected: readonly string[];
  /** Same key, different payload (price, capabilities or vendor terms changed). */
  changed: readonly string[];
  /** Same key, but the row is marked inactive. */
  inactive: readonly string[];
};

/** The mirror's unique key, spelled once so every map and finding agrees. */
export function modelConfigKey(entry: { role: string; provider: string; modelId: string }): string {
  return `${entry.role}\u0000${entry.provider}\u0000${entry.modelId}`;
}

/** The model's own payload in the mirror row — what an operator reads to explain a
 * call's identity, price and terms. */
function mirrorPayload(model: ModelConfig, vendor: VendorConfig): Record<string, unknown> {
  return {
    capabilities: [...model.capabilities],
    ...(model.dimensions !== undefined ? { dimensions: model.dimensions } : {}),
    priceMicroUsdPerMTok: {
      in: model.priceMicroUsdPerMTok.in,
      out: model.priceMicroUsdPerMTok.out,
    },
    vendor: {
      protocol: vendor.protocol,
      freeTier: vendor.freeTier,
      personalDataAllowed: vendor.personalDataAllowed,
    },
  };
}

function compareEntries(a: ModelConfigEntry, b: ModelConfigEntry): number {
  return (
    a.role.localeCompare(b.role) ||
    a.provider.localeCompare(b.provider) ||
    a.modelId.localeCompare(b.modelId)
  );
}

/**
 * Flatten the effective config into one row per `(role, provider, model_id)`
 * candidate, sorted so two derivations of the same config are byte-identical. A role
 * chain naming the same candidate twice collapses to one row, which is what the
 * table's unique constraint demands.
 */
export function modelConfigEntries(config: ProviderConfig): ModelConfigEntry[] {
  const entries = new Map<string, ModelConfigEntry>();
  for (const [role, declared] of Object.entries(config.roles)) {
    for (const candidate of declared.chain) {
      const [provider, modelId] = parseCandidateKey(candidate);
      const vendor = config.vendors[provider];
      if (vendor === undefined) {
        throw new ProviderConfigError(
          `model config mirror: role "${role}" names unknown provider "${provider}"`,
        );
      }
      const model = vendor.models[modelId];
      if (model === undefined) {
        throw new ProviderConfigError(
          `model config mirror: role "${role}" names unknown model "${modelId}" on provider "${provider}"`,
        );
      }
      const entry: ModelConfigEntry = {
        role,
        provider,
        modelId,
        config: mirrorPayload(model, vendor),
      };
      const key = modelConfigKey(entry);
      if (!entries.has(key)) entries.set(key, entry);
    }
  }
  return [...entries.values()].sort(compareEntries);
}

/** Canonical JSON: object keys sorted recursively, arrays in order. The adapter's
 * JSONB round-trip may reorder keys, and key order is not part of a config value. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Every way the mirror disagrees with the derived config: a derived entry with no
 * row, a row the config does not name, a row whose payload changed, and a row the
 * adapter would treat as not current. An empty result is the only state in which the
 * admin may read the mirror; the route answers a 503 otherwise.
 */
export function modelConfigDrift(
  entries: readonly ModelConfigEntry[],
  rows: readonly ModelConfigRecord[],
): ModelConfigDrift {
  const expected = new Map(entries.map((entry) => [modelConfigKey(entry), entry]));
  const seen = new Set<string>();
  const missing: string[] = [];
  const unexpected: string[] = [];
  const changed: string[] = [];
  const inactive: string[] = [];
  for (const row of rows) {
    const key = modelConfigKey(row);
    const entry = expected.get(key);
    if (entry === undefined) {
      unexpected.push(key);
      continue;
    }
    seen.add(key);
    if (!row.active) inactive.push(key);
    if (canonical(row.config) !== canonical(entry.config)) changed.push(key);
  }
  for (const key of expected.keys()) {
    if (!seen.has(key)) missing.push(key);
  }
  return {
    missing: missing.sort(),
    unexpected: unexpected.sort(),
    changed: changed.sort(),
    inactive: inactive.sort(),
  };
}

/** True when the drift has no finding — the one state in which the mirror is current. */
export function modelConfigDriftEmpty(drift: ModelConfigDrift): boolean {
  return (
    drift.missing.length === 0 &&
    drift.unexpected.length === 0 &&
    drift.changed.length === 0 &&
    drift.inactive.length === 0
  );
}
