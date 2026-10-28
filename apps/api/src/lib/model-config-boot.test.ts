import { describe, expect, it } from "vite-plus/test";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import { runStoreEffect } from "@app/kajianq-domain";
import {
  createLogger,
  loadProviderConfig,
  modelConfigEntries,
  StoreError,
  type ModelConfigEntry,
  type ProviderConfig,
  type RagStore,
} from "@app/infra";
import { syncModelConfigMirror } from "./model-config-boot";
import { ChatConfigError } from "./chat-wiring";

/**
 * The boot-time model-config sync (ADR-0022 decision 3).
 *
 * The cases that make the startup posture honest: a database-less process skips
 * without failing, a first sync fills an empty mirror, a second sync leaves one row
 * set, and a mirror that disagrees with the config — whether because a config edit
 * changed the entries or a writer left a retired row — is reported as `ok: false` with
 * a structured error instead of being served later. An unknown-provider chain is a
 * typed failure before any row is written, never a partial mirror.
 */

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ service: "api", route: "bootstrap" }, (line) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  });
  return { lines, logger };
}

const retired: ModelConfigEntry = {
  role: "generator",
  provider: "retired",
  modelId: "retired-model",
  config: { priceMicroUsdPerMTok: { in: 1, out: 1 } },
};

describe("the boot-time model-config sync", () => {
  it("skips without failing when no store is configured", async () => {
    const { lines, logger } = capture();
    const result = await syncModelConfigMirror(
      {},
      {
        createStore: () => {
          throw new ChatConfigError("chat route: DATABASE_URL is not bound", "DATABASE_URL");
        },
        logger,
      },
    );
    expect(result).toEqual({ ok: true, skipped: true, synced: 0, drift: null });
    expect(lines.map((line) => line.msg)).toContain("model_config.sync_skipped");
  });

  it("fills an empty mirror and is idempotent on the second run", async () => {
    const store = createMemoryRagStore();
    const { lines, logger } = capture();
    const first = await syncModelConfigMirror({}, { createStore: () => store, logger });
    const expected = modelConfigEntries(loadProviderConfig()).length;
    expect(expected).toBeGreaterThan(0);
    expect(first).toEqual({ ok: true, skipped: false, synced: expected, drift: null });
    const second = await syncModelConfigMirror({}, { createStore: () => store, logger });
    expect(second).toEqual(first);
    expect(await runStoreEffect(store.listModelConfigs())).toHaveLength(expected);
    expect(lines.filter((line) => line.msg === "model_config.synced")).toHaveLength(2);
  });

  it("empties the mirror for an empty config", async () => {
    const store = createMemoryRagStore();
    const { logger } = capture();
    await syncModelConfigMirror({}, { createStore: () => store, logger });
    const empty: ProviderConfig = { vendors: {}, roles: {} };
    const result = await syncModelConfigMirror(
      {},
      {
        config: empty,
        createStore: () => store,
        logger,
      },
    );
    expect(result).toEqual({ ok: true, skipped: false, synced: 0, drift: null });
    expect(await runStoreEffect(store.listModelConfigs())).toEqual([]);
  });

  it("reports drift when the mirror disagrees with the config after the sync", async () => {
    const store = createMemoryRagStore();
    // A retired row written by an older config: the shape a writer that skipped the
    // sync leaves behind. The boot sync's own write is faked away, so the post-sync
    // read sees this stale mirror — the same state a concurrent writer produces.
    await runStoreEffect(store.syncModelConfigs([retired]));
    let calls = 0;
    const runStore = (async (effect: unknown) => {
      calls += 1;
      if (calls === 1) return undefined; // the sync "succeeded" without changing a row
      return runStoreEffect(effect as Parameters<typeof runStoreEffect>[0]);
    }) as typeof runStoreEffect;
    const { lines, logger } = capture();
    const result = await syncModelConfigMirror({}, { createStore: () => store, runStore, logger });
    expect(result.ok).toBe(false);
    expect(result.drift?.unexpected).toHaveLength(1);
    expect(result.drift?.missing.length).toBeGreaterThan(0);
    expect(lines.find((line) => line.msg === "model_config.drift")).toMatchObject({
      level: "error",
      unexpected: 1,
    });
  });

  it("fails closed on a chain naming an unknown provider, writing no row", async () => {
    const store = createMemoryRagStore();
    const config: ProviderConfig = {
      vendors: {},
      roles: { generator: { chain: ["missing-vendor:m-chat"] } },
    };
    const { lines, logger } = capture();
    const result = await syncModelConfigMirror({}, { config, createStore: () => store, logger });
    expect(result).toEqual({ ok: false, skipped: false, synced: 0, drift: null });
    expect(lines.find((line) => line.msg === "model_config.sync_failed")).toMatchObject({
      level: "error",
      reason: "derive",
    });
    expect(await runStoreEffect(store.listModelConfigs())).toEqual([]);
  });

  it("reports a store failure without throwing, so serving still starts", async () => {
    const { lines, logger } = capture();
    const failing = (async () => {
      throw new StoreError({ kind: "transport", cause: new Error("refused") });
    }) as typeof runStoreEffect;
    const result = await syncModelConfigMirror(
      {},
      { createStore: () => createMemoryRagStore() as RagStore, runStore: failing, logger },
    );
    expect(result).toEqual({ ok: false, skipped: false, synced: 0, drift: null });
    expect(lines.find((line) => line.msg === "model_config.sync_failed")).toMatchObject({
      level: "error",
      reason: "store",
    });
  });
});
