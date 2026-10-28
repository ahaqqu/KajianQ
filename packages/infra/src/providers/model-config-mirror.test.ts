import { describe, expect, it } from "vite-plus/test";
import type { ModelConfigEntry, ModelConfigRecord } from "../rag-store-model-config-seam";
import {
  modelConfigDrift,
  modelConfigDriftEmpty,
  modelConfigEntries,
  modelConfigKey,
  type ModelConfigDrift,
} from "./model-config-mirror";
import { ProviderConfigError, type ProviderConfig } from "./provider-config";
import { altVendor, testVendor } from "./test-fixtures";

/**
 * The mirror derivation and drift check (ADR-0022 decision 3).
 *
 * The property under test is that the derived set is EXACTLY the config's effective
 * role→provider→model mapping, and that every way it can stop being exact is visible:
 * a missing row, a row the config does not name (a removed model left behind), a
 * changed payload (a price or terms edit that skipped the sync), and an inactive row.
 * The failure this guards is silent: an admin page decorated with a retired model or
 * price reads as current because nothing compares the two.
 */

/** Two vendors, three roles, and a role chain that names the same candidate twice —
 * the shape the unique `(role, provider, model_id)` constraint collapses to one row. */
function config(): ProviderConfig {
  return {
    vendors: { test: testVendor, alt: altVendor },
    roles: {
      generator: { chain: ["test:m-chat", "alt:alt-chat"] },
      reviewer: { chain: ["test:m-chat", "test:m-chat"] },
      embedder: { chain: ["test:m-embed"] },
    },
  };
}

/** The rows a deployment holds after syncing the given entries. */
function recordsOf(
  entries: readonly ModelConfigEntry[],
  overrides: (entry: ModelConfigEntry) => Partial<ModelConfigRecord> = () => ({}),
): ModelConfigRecord[] {
  return entries.map((entry) => ({ ...entry, active: true, updatedAt: 0, ...overrides(entry) }));
}

function expectDrift(drift: ModelConfigDrift, expected: Partial<ModelConfigDrift>): void {
  expect(drift).toEqual({
    missing: [],
    unexpected: [],
    changed: [],
    inactive: [],
    ...expected,
  });
  expect(modelConfigDriftEmpty(drift)).toBe(Object.keys(expected).length === 0);
}

describe("the model-config mirror's derivation", () => {
  it("derives one sorted row per (role, provider, model) candidate", () => {
    const entries = modelConfigEntries(config());
    expect(entries.map((entry) => `${entry.role}:${entry.provider}:${entry.modelId}`)).toEqual([
      "embedder:test:m-embed",
      "generator:alt:alt-chat",
      "generator:test:m-chat",
      "reviewer:test:m-chat",
    ]);
    // The reviewer chain names the same candidate twice; the unique constraint would
    // reject the second, so the derivation collapses it rather than handing the store a
    // duplicate to fail on.
    expect(new Set(entries.map(modelConfigKey)).size).toBe(entries.length);
  });

  it("carries the model's own price, capabilities and vendor terms", () => {
    const entries = modelConfigEntries(config());
    const chat = entries.find((entry) => entry.modelId === "m-chat");
    expect(chat?.config).toEqual({
      capabilities: ["generate", "stream"],
      priceMicroUsdPerMTok: { in: 500, out: 3000 },
      vendor: { protocol: "chat-completions", freeTier: true, personalDataAllowed: false },
    });
    const embed = entries.find((entry) => entry.modelId === "m-embed");
    // A dimension is present only where the model declares one.
    expect(embed?.config).toMatchObject({
      dimensions: 8,
      priceMicroUsdPerMTok: { in: 100, out: 0 },
    });
  });

  it("returns no rows for an empty config", () => {
    expect(modelConfigEntries({ vendors: {}, roles: {} })).toEqual([]);
  });

  it("fails closed on a chain naming an unknown provider", () => {
    // The config loader rejects this before the mirror sees it; the derivation still
    // refuses rather than skipping the candidate, because a skipped candidate would
    // leave a mirror that looks complete while a serving role is missing from it.
    const broken: ProviderConfig = {
      ...config(),
      roles: { generator: { chain: ["missing-vendor:m-chat"] } },
    };
    expect(() => modelConfigEntries(broken)).toThrow(ProviderConfigError);
    expect(() => modelConfigEntries(broken)).toThrow(/unknown provider/);
  });

  it("fails closed on a chain naming an unknown model", () => {
    const broken: ProviderConfig = {
      ...config(),
      roles: { generator: { chain: ["test:not-a-model"] } },
    };
    expect(() => modelConfigEntries(broken)).toThrow(ProviderConfigError);
    expect(() => modelConfigEntries(broken)).toThrow(/unknown model/);
  });
});

describe("the model-config drift check", () => {
  it("reports no drift when the mirror is the derived set, in any row order", () => {
    const entries = modelConfigEntries(config());
    expectDrift(modelConfigDrift(entries, recordsOf(entries)), {});
    expectDrift(modelConfigDrift(entries, recordsOf(entries).reverse()), {});
  });

  it("reports a derived entry with no mirror row as missing", () => {
    const entries = modelConfigEntries(config());
    const rows = recordsOf(entries).slice(1);
    const missing = modelConfigKey(entries[0]!);
    expectDrift(modelConfigDrift(entries, rows), { missing: [missing] });
  });

  it("reports a row the config does not name as unexpected", () => {
    const entries = modelConfigEntries(config());
    const retired: ModelConfigRecord = {
      role: "generator",
      provider: "retired",
      modelId: "retired-model",
      config: { priceMicroUsdPerMTok: { in: 1, out: 900_000 } },
      active: true,
      updatedAt: 0,
    };
    expectDrift(modelConfigDrift(entries, [...recordsOf(entries), retired]), {
      unexpected: [modelConfigKey(retired)],
    });
  });

  it("reports a changed price as drift, not as a row that happens to differ", () => {
    const entries = modelConfigEntries(config());
    const rows = recordsOf(entries, (entry) =>
      entry.modelId === "m-chat"
        ? {
            config: {
              ...entry.config,
              priceMicroUsdPerMTok: { in: 501, out: 3000 },
            },
          }
        : {},
    );
    const changed = entries
      .filter((entry) => entry.modelId === "m-chat")
      .map(modelConfigKey)
      .sort();
    expectDrift(modelConfigDrift(entries, rows), { changed });
  });

  it("treats a vendor-terms edit as drift", () => {
    // `personalDataAllowed`/`freeTier` are privacy-relevant config values; a mirror that
    // still advertises the old terms must not be served as current.
    const entries = modelConfigEntries(config());
    const rows = recordsOf(entries, (entry) =>
      entry.modelId === "m-chat"
        ? {
            config: {
              ...entry.config,
              vendor: { ...(entry.config.vendor as object), personalDataAllowed: true },
            },
          }
        : {},
    );
    expectDrift(modelConfigDrift(entries, rows), {
      changed: entries
        .filter((entry) => entry.modelId === "m-chat")
        .map(modelConfigKey)
        .sort(),
    });
  });

  it("reports an inactive row as drift", () => {
    const entries = modelConfigEntries(config());
    const rows = recordsOf(entries, (entry) =>
      entry.modelId === "m-embed" ? { active: false } : {},
    );
    expectDrift(modelConfigDrift(entries, rows), {
      inactive: entries.filter((entry) => entry.modelId === "m-embed").map(modelConfigKey),
    });
  });

  it("compares object key order as irrelevant", () => {
    const entries = modelConfigEntries(config());
    const rows = recordsOf(entries, (entry) => ({
      config: {
        vendor: entry.config.vendor,
        priceMicroUsdPerMTok: entry.config.priceMicroUsdPerMTok,
        capabilities: entry.config.capabilities,
        ...(entry.config.dimensions !== undefined ? { dimensions: entry.config.dimensions } : {}),
      },
    }));
    expectDrift(modelConfigDrift(entries, rows), {});
  });

  it("reports drift when the config becomes empty but the mirror is not", () => {
    const entries = modelConfigEntries(config());
    expectDrift(modelConfigDrift([], recordsOf(entries)), {
      unexpected: entries.map(modelConfigKey).sort(),
    });
  });
});
