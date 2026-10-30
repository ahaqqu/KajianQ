import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  modelConfigDrift,
  modelConfigDriftEmpty,
  StoreError,
  type ModelConfigRecord,
} from "@app/infra";
import { createMemoryRagStore } from "./memory-rag-store";
import {
  memoryModelConfigMethods,
  type MemoryModelConfigState,
} from "./memory-rag-store-model-config";

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

  it("rejects two entries sharing a (role, provider, model_id) key, like the adapter", async () => {
    const store = createMemoryRagStore();
    const kept = entry("m-chat");
    await Effect.runPromise(store.syncModelConfigs([kept]));
    // The same key twice: the adapter's single ON CONFLICT DO UPDATE rejects the pair
    // with SQLSTATE 21000 (cardinality_violation → `constraint`), so the double must
    // not keep the last entry and call it a sync.
    const failure = await Effect.runPromise(
      store.syncModelConfigs([kept, entry("m-chat", "generator", 900)]).pipe(Effect.flip),
    );
    expect(failure).toBeInstanceOf(StoreError);
    expect(failure.kind).toBe("constraint");
    // The failed sync wrote nothing: the adapter's transaction rolls back, and a
    // duplicate must not half-apply a row set here either.
    const rows = await rowsOf(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.config.priceMicroUsdPerMTok).toEqual({ in: 500, out: 3000 });
  });

  it("revives a named row marked inactive out of band", async () => {
    const state: MemoryModelConfigState = { rows: new Map(), now: () => 1_700_000_000_000 };
    const methods = memoryModelConfigMethods(state);
    const entries = [entry("m-chat")];
    await Effect.runPromise(methods.syncModelConfigs(entries));
    // Out of band: the row is marked inactive without the sync seeing it — the state a
    // hand-written `UPDATE` (or a half-finished retention job) leaves behind.
    const [key, row] = [...state.rows.entries()][0]!;
    state.rows.set(key, { ...row, active: false });
    const marked = modelConfigDrift(entries, await Effect.runPromise(methods.listModelConfigs()));
    expect(marked.inactive).toEqual([key]);
    // A sync over the same entry restores active = true rather than leaving a row no
    // sync can clear.
    await Effect.runPromise(methods.syncModelConfigs(entries));
    const revived: readonly ModelConfigRecord[] = await Effect.runPromise(
      methods.listModelConfigs(),
    );
    expect(revived.every((entry) => entry.active)).toBe(true);
    expect(modelConfigDriftEmpty(modelConfigDrift(entries, revived))).toBe(true);
  });
});
