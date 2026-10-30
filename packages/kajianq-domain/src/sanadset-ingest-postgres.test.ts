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
  fullNarration,
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
              WHERE source_key LIKE ${`hadith/${PROBE}%`}
                 OR source_key LIKE ${`sanadset/${PROBE}%`}`;
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
      children: { created: 1, updated: 0, unchanged: 0, deleted: 0 },
      chains: { created: 2, updated: 0, unchanged: 0, deleted: 0 },
      narratorsUpserted: 4,
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
      ordinal: 0,
      metadata: { sourceType: "hadith", collection: PROBE, ingestSource: "sanadset" },
    });
    expect(bySource.get("sanadset:row:1")?.childId).toBe(children[0]?.id);

    const narratorIds = page.rows[0]?.narratorIds ?? [];
    const narratorRows = (await sql!`SELECT identity_key, name_variants, metadata FROM narrators
                                      WHERE id = ANY(${narratorIds}::uuid[])`) as {
      identity_key: string;
      name_variants: string[];
      metadata: Record<string, unknown>;
    }[];
    expect(narratorRows).toHaveLength(narratorIds.length);
    for (const row of narratorRows) {
      expect(row.identity_key).toMatch(/^narrator:folded-name:/);
      // A Name cluster carries its provisional basis and provenance in metadata,
      // so a reader can tell it from a resolved Narrator.
      expect(row.metadata).toMatchObject({ identityBasis: "folded-name", nameCluster: true });
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
    expect(outcome.children).toEqual({ created: 0, updated: 0, unchanged: 1, deleted: 0 });
    expect(outcome.chains).toEqual({ created: 0, updated: 0, unchanged: 2, deleted: 0 });

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

  it("matches a Sanadset matn against a full-narration v1 child and attaches its chain", async () => {
    if (!store || !sql) throw new Error("postgres store not initialised");
    // The gated twin of the plan fixture: the stored child is the API edition's
    // whole narration, so the matn is a suffix of it, not the row's text.
    const collection = `${PROBE}full`;
    const scope = { key: "bukhari" as const, book: BUKHARI, collection };
    const narration = fullNarration(MATN_A);
    const fullChild = await seedCorpusChild(store, narration, { collection, ordinal: 0 });
    const { plan } = await planFrom(store, [sourceRow({ rowIndex: 0 })], { scope });
    expect(plan.groups[0]?.target).toMatchObject({
      kind: "existing",
      childId: fullChild,
      how: "containment",
    });
    expect(plan.children.created).toHaveLength(0);

    const outcome = await executeIngestPlan({ store, plan, gate: ESCAPE_GATE });
    expect(outcome.children).toEqual({ created: 0, updated: 0, unchanged: 0, deleted: 0 });
    const chains = await Effect.runPromise(store.listChainsForChild(fullChild, { limit: 10 }));
    expect(chains.map((chain) => chain.sourceRef)).toEqual(["sanadset:row:0"]);
    const stored = (await sql`SELECT text_raw, text_ar FROM doc_children
                              WHERE id = ${fullChild}`) as { text_raw: string; text_ar: string }[];
    // The v1 row is untouched: its raw narration is not rewritten to the matn.
    expect(stored[0]?.text_raw).toBe(narration);
    expect(stored[0]?.text_ar).toBe(narration);
  });

  it("removes the pilot's stale child and moves its chain to a corpus target", async () => {
    if (!store || !sql) throw new Error("postgres store not initialised");
    const collection = `${PROBE}rc`;
    const scope = { key: "bukhari" as const, book: BUKHARI, collection };
    const rows = [
      sourceRow({ rowIndex: 0 }),
      sourceRow({ rowIndex: 1, hadithNumber: "2", matn: MATN_B, sanadLength: 2 }),
    ];
    await executeIngestPlan({
      store,
      plan: (await planFrom(store, rows, { scope })).plan,
      gate: ESCAPE_GATE,
    });
    const corpusB = await seedCorpusChild(store, fullNarration(MATN_B), {
      collection,
      ordinal: 5,
    });
    const second = await planFrom(store, rows, { scope });
    const outcome = await executeIngestPlan({ store, plan: second.plan, gate: ESCAPE_GATE });
    expect(outcome.children).toEqual({ created: 0, updated: 0, unchanged: 1, deleted: 1 });
    expect(outcome.chains).toEqual({ created: 0, updated: 1, unchanged: 1, deleted: 0 });

    const childCount = (await sql`SELECT count(*)::int AS n FROM doc_children
                                  WHERE parent_id = (SELECT id FROM doc_parents
                                                     WHERE source_key = ${`sanadset/${collection}`})`) as {
      n: number;
    }[];
    expect(childCount[0]?.n).toBe(1);
    const chainRows = (await sql`SELECT source_ref, child_id FROM narrator_chains
                                 WHERE collection = ${collection} ORDER BY source_ref`) as {
      source_ref: string;
      child_id: string;
    }[];
    expect(chainRows).toHaveLength(2);
    expect(chainRows.find((row) => row.source_ref === "sanadset:row:1")?.child_id).toBe(corpusB);
  });

  it("removes the chain and child of a group a newer plan quarantines", async () => {
    if (!store || !sql) throw new Error("postgres store not initialised");
    const collection = `${PROBE}q`;
    const scope = { key: "bukhari" as const, book: BUKHARI, collection };
    const firstRows = [
      sourceRow({ rowIndex: 0 }),
      sourceRow({ rowIndex: 1, hadithNumber: "2", matn: MATN_B, sanadLength: 2 }),
    ];
    await executeIngestPlan({
      store,
      plan: (await planFrom(store, firstRows, { scope })).plan,
      gate: ESCAPE_GATE,
    });

    const secondRows = [
      sourceRow({ rowIndex: 0 }),
      sourceRow({ rowIndex: 1, hadithNumber: "2", matn: MATN_B, sanadLength: 40 }),
    ];
    const second = await planFrom(store, secondRows, { scope });
    const outcome = await executeIngestPlan({ store, plan: second.plan, gate: ESCAPE_GATE });
    expect(outcome.children).toEqual({ created: 0, updated: 0, unchanged: 1, deleted: 1 });
    expect(outcome.chains).toEqual({ created: 0, updated: 0, unchanged: 1, deleted: 1 });

    const counts = (await sql`SELECT
        (SELECT count(*)::int FROM doc_children WHERE parent_id =
           (SELECT id FROM doc_parents WHERE source_key = ${`sanadset/${collection}`})) AS children,
        (SELECT count(*)::int FROM narrator_chains WHERE collection = ${collection}) AS chains`) as {
      children: number;
      chains: number;
    }[];
    expect(counts[0]).toEqual({ children: 1, chains: 1 });
  });

  it("keeps raw text and derived fields on the same narration across a reorder", async () => {
    if (!store || !sql) throw new Error("postgres store not initialised");
    const collection = `${PROBE}ord`;
    const scope = { key: "bukhari" as const, book: BUKHARI, collection };
    const firstRows = [
      sourceRow({ rowIndex: 0, hadithNumber: "1" }),
      sourceRow({ rowIndex: 1, hadithNumber: "2", matn: MATN_B, sanadLength: 2 }),
    ];
    await executeIngestPlan({
      store,
      plan: (await planFrom(store, firstRows, { scope })).plan,
      gate: ESCAPE_GATE,
    });

    const swapped = [
      sourceRow({ rowIndex: 0, hadithNumber: "2", matn: MATN_B, sanadLength: 2 }),
      sourceRow({ rowIndex: 1, hadithNumber: "1", matn: MATN_A, sanadLength: 2 }),
    ];
    const second = await planFrom(store, swapped, { scope });
    const outcome = await executeIngestPlan({ store, plan: second.plan, gate: ESCAPE_GATE });
    expect(outcome.children).toEqual({ created: 0, updated: 2, unchanged: 0, deleted: 0 });

    const rows = (await sql`SELECT c.text_raw, c.text_ar, c.metadata
                            FROM doc_children c JOIN doc_parents p ON p.id = c.parent_id
                            WHERE p.source_key = ${`sanadset/${collection}`}
                            ORDER BY c.ordinal`) as {
      text_raw: string;
      text_ar: string;
      metadata: Record<string, unknown>;
    }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.text_raw).toBe(row.text_ar);
    const bySourceRow = new Map(
      rows.map((row) => [String(row.metadata["sanadsetRowIndex"]), row.text_raw]),
    );
    expect(bySourceRow.get("0")).toBe(MATN_B);
    expect(bySourceRow.get("1")).toBe(MATN_A);
    const chainText = (await sql`SELECT ch.source_ref, c.text_raw
                                 FROM narrator_chains ch JOIN doc_children c ON c.id = ch.child_id
                                 WHERE ch.collection = ${collection}`) as {
      source_ref: string;
      text_raw: string;
    }[];
    expect(chainText.find((row) => row.source_ref === "sanadset:row:0")?.text_raw).toBe(MATN_B);
    expect(chainText.find((row) => row.source_ref === "sanadset:row:1")?.text_raw).toBe(MATN_A);
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
