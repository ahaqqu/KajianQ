// @requires-postgres
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { modelConfigDrift } from "./providers/model-config-mirror";
import { createPostgresRagStore } from "./rag-store-postgres";
import { disposePostgresPools, postgresPool, postgresSqlRunner } from "./rag-store-postgres-driver";
import type { SqlRunner } from "./rag-store-postgres-errors";
import type { ModelConfigRecord } from "./rag-store-model-config-seam";
import type { RagStore } from "./rag-store";

/**
 * The `model_configs` mirror's real-Postgres contract (ADR-0022 decision 3).
 *
 * The properties that can only be checked against the schema the deployment runs:
 * the sync is idempotent under the table's UNIQUE `(role, provider, model_id)` — a
 * second run updates in place instead of colliding or duplicating — a config edit is
 * an update and a removed entry is a DELETE rather than a lingering row, and the
 * drift check sees a row written out of band (the mirror going stale is exactly what
 * the admin gate refuses to serve). The in-memory double runs the same cases beside
 * this file so the route tests cannot pass on a more forgiving store.
 *
 * REQUIRES A DISPOSABLE DATABASE. The suite replaces the mirror, which is derived
 * state a boot restores — but a run against staging would briefly leave its admin
 * detail refusing every read with drift, so `beforeAll` refuses unless the operator
 * states the target is disposable. It does not infer it from an empty table.
 */

const URL = process.env.DATABASE_URL;
const run = URL ? describe : describe.skip;

/** The explicit disposability fact: an operator states it; the suite never infers it. */
const DISPOSABLE = process.env.KAJIANQ_MODEL_CONFIG_TEST_DISPOSABLE === "1";

let sql: SqlRunner | null = null;
let store: RagStore;

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

async function rowsOf(): Promise<readonly ModelConfigRecord[]> {
  return Effect.runPromise(store.listModelConfigs());
}

run("RagStore model-config mirror contract (real Postgres)", () => {
  beforeAll(async () => {
    if (!URL) return;
    if (!DISPOSABLE) {
      throw new Error(
        "rag-store-postgres-model-config: DATABASE_URL is set but this run did not state " +
          "that the database is disposable. Set KAJIANQ_MODEL_CONFIG_TEST_DISPOSABLE=1 when " +
          "DATABASE_URL names a throwaway database (a scratch instance with " +
          "`bun run db:up:all`); this suite replaces the model_configs mirror, and it will " +
          "not guess from an empty table.",
      );
    }
    sql = postgresSqlRunner(postgresPool(URL));
    store = createPostgresRagStore(sql);
    // Start from a known mirror; the sync below is what a boot runs.
    await Effect.runPromise(store.syncModelConfigs([]));
  });

  afterAll(async () => {
    if (!URL) return;
    // Leave the table as an empty derived set: this database is disposable, and a
    // later suite must not read rows this one happened to leave.
    await Effect.runPromise(store.syncModelConfigs([]));
    await disposePostgresPools();
  });

  it("leaves one row set when the same sync runs twice", async () => {
    const entries = [entry("m-chat"), entry("m-embed", "embedder")];
    await Effect.runPromise(store.syncModelConfigs(entries));
    await Effect.runPromise(store.syncModelConfigs(entries));
    const rows = await rowsOf();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => `${row.role}/${row.provider}/${row.modelId}`)).size).toBe(2);
    // The stored table, not only the projection: the unique constraint's key space
    // holds exactly the derived keys.
    const counted = (await sql!.query(
      `SELECT count(*)::int AS total, count(DISTINCT (role, provider, model_id))::int AS keys
       FROM model_configs`,
    )) as { total: number; keys: number }[];
    expect(counted[0]).toEqual({ total: 2, keys: 2 });
    // The JSONB round-trip is not the derived payload byte-for-byte: object key order
    // and numeric typing come back the driver's way. The drift check must read that as
    // the SAME config, or every booted deployment would refuse its own mirror.
    expect(modelConfigDrift(entries, rows)).toEqual({
      missing: [],
      unexpected: [],
      changed: [],
      inactive: [],
    });
  });

  it("updates a changed entry in place and keeps the other rows", async () => {
    await Effect.runPromise(
      store.syncModelConfigs([entry("m-chat"), entry("m-embed", "embedder")]),
    );
    await Effect.runPromise(
      store.syncModelConfigs([entry("m-chat", "generator", 900), entry("m-embed", "embedder")]),
    );
    const rows = await rowsOf();
    expect(rows).toHaveLength(2);
    const chat = rows.find((row) => row.modelId === "m-chat")!;
    expect(chat.config.priceMicroUsdPerMTok).toEqual({ in: 900, out: 3000 });
  });

  it("removes a row the new entry set no longer names", async () => {
    await Effect.runPromise(
      store.syncModelConfigs([entry("m-chat"), entry("m-embed", "embedder")]),
    );
    await Effect.runPromise(store.syncModelConfigs([entry("m-chat")]));
    expect((await rowsOf()).map((row) => row.modelId)).toEqual(["m-chat"]);
  });

  it("empties the mirror for an empty config", async () => {
    await Effect.runPromise(store.syncModelConfigs([entry("m-chat")]));
    await Effect.runPromise(store.syncModelConfigs([]));
    expect(await rowsOf()).toEqual([]);
  });

  it("returns rows in the adapter's (role, provider, model) order", async () => {
    await Effect.runPromise(
      store.syncModelConfigs([
        entry("m-chat", "reviewer"),
        entry("m-chat", "generator"),
        entry("m-embed", "embedder"),
      ]),
    );
    expect((await rowsOf()).map((row) => `${row.role}:${row.modelId}`)).toEqual([
      "embedder:m-embed",
      "generator:m-chat",
      "reviewer:m-chat",
    ]);
  });

  it("sees a row written out of band as drift, and the next sync removes it", async () => {
    const entries = [entry("m-chat")];
    await Effect.runPromise(store.syncModelConfigs(entries));
    // A mirror row an older config left behind: the table is writable, so the drift
    // check — not the writer's discipline — is what makes it visible.
    await sql!.query(
      `INSERT INTO model_configs (role, provider, model_id, config, active)
       VALUES ('generator', 'retired', 'retired-model', '{"priceMicroUsdPerMTok":{"in":1,"out":1}}'::jsonb, true)`,
    );
    const drift = modelConfigDrift(entries, await rowsOf());
    expect(drift.unexpected).toHaveLength(1);
    expect(drift.unexpected[0]).toContain("retired");
    // The sync is the fix, and it is a delete: no row claims to be current afterward.
    await Effect.runPromise(store.syncModelConfigs(entries));
    expect(modelConfigDrift(entries, await rowsOf()).unexpected).toEqual([]);
  });
});
