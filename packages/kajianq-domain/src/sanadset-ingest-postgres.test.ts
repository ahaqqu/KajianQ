// @requires-postgres
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import {
  createPostgresRagStore,
  disposePostgresPools,
  postgresPool,
  postgresSqlRunner,
  type RagStore,
} from "@app/infra";
import {
  BUKHARI,
  ESCAPE_GATE,
  MATN_A,
  MATN_B,
  planFrom,
  seedCorpusChild,
  sourceRow,
} from "./test-utils/sanadset-pilot-fixture";
import { executeIngestPlan } from "./sanadset-ingest-write";

/**
 * The pilot's write path against real Postgres.
 *
 * Test intent, named before the assertions:
 * - trap: the plan's target set is one collection's children. A stored child of
 *   another collection with an identical matn is asserted to be *not* the target,
 *   while the same collection's child is — the wrong target here attaches an isnad
 *   to another book's narration;
 * - trap: a rerun must not duplicate a narrator, a child or a chain. The second run
 *   rebuilds the plan the way the next run would (the pilot's own children excluded
 *   from the target set) and asserts exact row counts through SQL;
 * - trap: the refusal must happen before any row is written. A refused gate on the
 *   real adapter is followed by an unchanged chain count.
 *
 * The suite writes under a per-run collection key and deletes it afterwards, so it
 * shares the contract database with the other gated suites without collisions.
 */

const URL = process.env.DATABASE_URL;
const run = URL ? describe : describe.skip;

const PROBE = `s2probe${Math.random().toString(36).slice(2, 8)}`;
const SCOPE = { key: "bukhari" as const, book: BUKHARI, collection: PROBE };

run("the pilot write path (real Postgres)", () => {
  let sql: ReturnType<typeof postgresSqlRunner> | null = null;
  let store: RagStore | null = null;
  let seededChild = "";

  beforeAll(async () => {
    if (!URL) return;
    sql = postgresSqlRunner(postgresPool(URL));
    store = createPostgresRagStore(sql);
    seededChild = await seedCorpusChild(store, MATN_A, { collection: PROBE, ordinal: 0 });
    // Another collection's child with the second row's matn: never this plan's target.
    await seedCorpusChild(store, MATN_B, { collection: `${PROBE}-other`, ordinal: 1 });
  });

  afterAll(async () => {
    if (!URL || sql === null) return;
    const mine = (await sql`SELECT DISTINCT unnest(narrator_ids) AS id
                            FROM narrator_chains WHERE collection LIKE ${`${PROBE}%`}`) as {
      id: string;
    }[];
    await sql`DELETE FROM narrator_chains WHERE collection LIKE ${`${PROBE}%`}`;
    if (mine.length > 0) {
      await sql`DELETE FROM narrators WHERE id = ANY(${mine.map((row) => row.id)}::uuid[])`;
    }
    await sql`DELETE FROM doc_parents
              WHERE source_key LIKE ${`hadith/${PROBE}%`} OR source_key = ${`sanadset/${PROBE}`}`;
    await disposePostgresPools();
  });

  it("writes the plan, targets only its own collection, and reads it back through the seam", async () => {
    if (!store) throw new Error("postgres store not initialised");
    const rows = [
      sourceRow({ rowIndex: 0 }),
      sourceRow({
        rowIndex: 1,
        hadithNumber: "2",
        matn: MATN_B,
        sanad: `['سالم', 'عبد الله بن عمر']`,
      }),
    ];
    const first = await planFrom(store, rows, { scope: SCOPE });
    expect(first.plan.groups[0]?.target).toMatchObject({ kind: "existing", childId: seededChild });
    expect(first.plan.groups[1]?.target).toEqual({ kind: "new" });
    expect(first.plan.children.compared).toBe(1);

    const outcome = await executeIngestPlan({ store, plan: first.plan, gate: ESCAPE_GATE });
    expect(outcome).toEqual({
      parentId: expect.any(String),
      childrenCreated: 1,
      chainsWritten: 2,
      narratorsWritten: 4,
    });

    const page = await Effect.runPromise(store.listChainsByCollection(PROBE, { limit: 10 }));
    expect(page.rows).toHaveLength(2);
    expect(page.nextAfterId).toBeNull();
    const bySource = new Map(page.rows.map((chain) => [chain.sourceRef, chain]));
    expect(bySource.get("sanadset:row:0")?.childId).toBe(seededChild);
    for (const chain of page.rows) {
      expect(chain.collection).toBe(PROBE);
      expect(chain.grade).toBeNull();
      expect(chain.grader).toBeNull();
      expect(chain.narratorIds).toHaveLength(2);
    }

    const children = await Effect.runPromise(
      store.listDocChildrenByParentSourceKey(`sanadset/${PROBE}`, { limit: 10 }),
    );
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      textRaw: MATN_B,
      embeddingPrimary: null,
      ordinal: 1,
      metadata: { sourceType: "hadith", collection: PROBE, ingestSource: "sanadset" },
    });
    expect(bySource.get("sanadset:row:1")?.childId).toBe(children[0]?.id);

    const narratorIds = page.rows[0]?.narratorIds ?? [];
    const narratorRows = (await sql!`SELECT identity_key, name_variants FROM narrators
                                      WHERE id = ANY(${narratorIds}::uuid[])`) as {
      identity_key: string;
      name_variants: string[];
    }[];
    expect(narratorRows).toHaveLength(narratorIds.length);
    for (const row of narratorRows) {
      expect(row.identity_key).toMatch(/^narrator:folded-name:/);
    }
  });

  it("converges on a rerun: no duplicate narrator, child or chain", async () => {
    if (!store || !sql) throw new Error("postgres store not initialised");
    const rows = [
      sourceRow({ rowIndex: 0 }),
      sourceRow({
        rowIndex: 1,
        hadithNumber: "2",
        matn: MATN_B,
        sanad: `['سالم', 'عبد الله بن عمر']`,
      }),
    ];
    const second = await planFrom(store, rows, { scope: SCOPE });
    // The pilot's own child is not in the target set, so the rerun's plan is the first's.
    expect(second.plan.children.created).toHaveLength(1);
    expect(second.plan.children.compared).toBe(1);
    const outcome = await executeIngestPlan({ store, plan: second.plan, gate: ESCAPE_GATE });
    expect(outcome.childrenCreated).toBe(1);
    expect(outcome.chainsWritten).toBe(2);

    const chainCount = (await sql`SELECT count(*)::int AS n FROM narrator_chains
                                  WHERE collection = ${PROBE}`) as { n: number }[];
    expect(chainCount[0]?.n).toBe(2);
    const childCount = (await sql`SELECT count(*)::int AS n FROM doc_children
                                  WHERE parent_id = (SELECT id FROM doc_parents
                                                    WHERE source_key = ${`sanadset/${PROBE}`})`) as {
      n: number;
    }[];
    expect(childCount[0]?.n).toBe(1);
    const narratorCount = (await sql`SELECT count(DISTINCT id)::int AS n FROM narrators
                                     WHERE id IN (SELECT unnest(narrator_ids) FROM narrator_chains
                                                  WHERE collection = ${PROBE})`) as { n: number }[];
    expect(narratorCount[0]?.n).toBe(4);
  });

  it("refuses a run without the gate and leaves the rows untouched", async () => {
    if (!store || !sql) throw new Error("postgres store not initialised");
    const { plan } = await planFrom(store, [sourceRow({ rowIndex: 0 })], { scope: SCOPE });
    await expect(
      executeIngestPlan({
        store,
        plan,
        gate: {
          allowed: false,
          mode: "verified-snapshot",
          label: "pre-ingest-unverified",
          reasons: ["corpus drift"],
        },
      }),
    ).rejects.toThrow(/refusing to write/);
    const count = (await sql`SELECT count(*)::int AS n FROM narrator_chains
                             WHERE collection = ${PROBE}`) as { n: number }[];
    expect(count[0]?.n).toBe(2);
  });
});
