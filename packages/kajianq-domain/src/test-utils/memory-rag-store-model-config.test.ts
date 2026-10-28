import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { modelConfigDrift, modelConfigDriftEmpty } from "@app/infra";
import { createMemoryRagStore } from "./memory-rag-store";

/**
 * The in-memory `model_configs` mirror, held to the seam's semantics (ADR-0022
 * decision 3).
 *
 * These are the cases the Postgres contract suite runs against the real adapter: a
 * second sync leaves one row set, a config edit updates rather than duplicates, a
 * removed entry leaves no row claiming to be current, and an empty config empties the
 * mirror. The double exists so the admin route tests exercise a current mirror without
 * a database — a more forgiving double would let a drift bug pass every route test.
 */

const entry = (modelId: string, role = "generator", priceIn = 500) => ({
  role,
  provider: "alpha",
  modelId,
  config: {
    capabilities: ["generate"],
    priceMicroUsdPerMTok: { in: priceIn, out: 3000 },
    vendor: { protocol: "chat-completions", freeTier: true, personalDataAllowed: false },
  },
});

async function rowsOf(store: ReturnType<typeof createMemoryRagStore>) {
  return Effect.runPromise(store.listModelConfigs());
}

/** The row set without `updatedAt`, which a second sync legitimately rewrites. */
function shapeOf(
  rows: readonly {
    role: string;
    provider: string;
    modelId: string;
    config: unknown;
    active: boolean;
  }[],
) {
  return rows.map((row) => ({
    role: row.role,
    provider: row.provider,
    modelId: row.modelId,
    config: row.config,
    active: row.active,
  }));
}

describe("the in-memory model-config mirror", () => {
  it("leaves one row set when the same sync runs twice", async () => {
    const store = createMemoryRagStore();
    const entries = [entry("m-chat"), entry("m-embed", "embedder")];
    await Effect.runPromise(store.syncModelConfigs(entries));
    const first = await rowsOf(store);
    await Effect.runPromise(store.syncModelConfigs(entries));
    const second = await rowsOf(store);
    expect(shapeOf(second)).toEqual(shapeOf(first));
    expect(second).toHaveLength(2);
    // The unique key is untouched by the second run: one row per (role, provider, model).
    expect(new Set(second.map((row) => `${row.role}/${row.provider}/${row.modelId}`)).size).toBe(2);
  });

  it("updates a changed entry in place and keeps the other rows", async () => {
    const store = createMemoryRagStore();
    await Effect.runPromise(
      store.syncModelConfigs([entry("m-chat"), entry("m-embed", "embedder")]),
    );
    await Effect.runPromise(
      store.syncModelConfigs([entry("m-chat", "generator", 900), entry("m-embed", "embedder")]),
    );
    const rows = await rowsOf(store);
    expect(rows).toHaveLength(2);
    const chat = rows.find((row) => row.modelId === "m-chat")!;
    expect(chat.config.priceMicroUsdPerMTok).toEqual({ in: 900, out: 3000 });
  });

  it("removes a row the new entry set no longer names", async () => {
    const store = createMemoryRagStore();
    await Effect.runPromise(
      store.syncModelConfigs([entry("m-chat"), entry("m-embed", "embedder")]),
    );
    await Effect.runPromise(store.syncModelConfigs([entry("m-chat")]));
    const rows = await rowsOf(store);
    expect(rows.map((row) => row.modelId)).toEqual(["m-chat"]);
  });

  it("empties the mirror for an empty config", async () => {
    const store = createMemoryRagStore();
    await Effect.runPromise(store.syncModelConfigs([entry("m-chat")]));
    await Effect.runPromise(store.syncModelConfigs([]));
    expect(await rowsOf(store)).toEqual([]);
  });

  it("returns rows in the adapter's (role, provider, model) order", async () => {
    const store = createMemoryRagStore();
    await Effect.runPromise(
      store.syncModelConfigs([
        entry("m-chat", "reviewer"),
        entry("m-chat", "generator"),
        entry("m-embed", "embedder"),
      ]),
    );
    expect((await rowsOf(store)).map((row) => `${row.role}:${row.modelId}`)).toEqual([
      "embedder:m-embed",
      "generator:m-chat",
      "reviewer:m-chat",
    ]);
  });

  it("is the set the drift check compares against", async () => {
    const store = createMemoryRagStore();
    const entries = [entry("m-chat"), entry("m-embed", "embedder")];
    await Effect.runPromise(store.syncModelConfigs(entries));
    // A mirror that skipped the sync — the admin's failure mode — is visible as drift.
    expect(modelConfigDriftEmpty(modelConfigDrift(entries, await rowsOf(store)))).toBe(true);
    expect(modelConfigDrift([entry("m-chat")], await rowsOf(store)).unexpected).toHaveLength(1);
  });
});
