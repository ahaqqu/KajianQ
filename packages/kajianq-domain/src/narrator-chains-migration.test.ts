// @requires-postgres
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { disposePostgresPools, postgresPool } from "@app/infra";
import { GRADES } from "./filters";

/**
 * The narrator/chain migration against real Postgres, up and down.
 *
 * The property under test is the one a schema change fails silently at: the DDL
 * must be **additive** (pre-existing rows survive both directions), the invariants
 * a later reader trusts must be enforced by the database rather than by hope, and
 * the indexes the adapter's reads rely on must actually be usable.
 *
 * Everything runs inside a throwaway schema on the contract database, with a stub
 * `doc_children` table: the migration files are applied verbatim — the same bytes
 * `db:up:domain` applies — but neither the shared schema nor the ledger is touched,
 * so this suite can roll tables back and forth without disturbing another suite.
 * The stub is what proves additivity: a row written before `up` is still there
 * after it, and after `down`.
 */

const URL = process.env.DATABASE_URL;
const run = URL ? describe : describe.skip;

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const UP_FILE = join(MIGRATIONS, "0003_narrators_chains.sql");
const DOWN_FILE = join(MIGRATIONS, "0003_narrators_chains.down.sql");

/** The throwaway schema and its name (valid, unquoted identifier). */
const SCHEMA = `migration_probe_${Math.random().toString(36).slice(2, 10)}`;
const CHILD_ID = "00000000-0000-4000-8000-0000000000c1";
const NARRATOR_A = "00000000-0000-4000-8000-0000000000a1";
const NARRATOR_B = "00000000-0000-4000-8000-0000000000b1";

/**
 * One pooled connection, typed from a direct call expression: the pool's `connect`
 * overloads make `ReturnType<typeof pool.connect>` resolve to the callback form.
 */
async function connectProbe(connectionString: string) {
  return postgresPool(connectionString).connect();
}

const upSql = () => readFileSync(UP_FILE, "utf8");
const downSql = () => readFileSync(DOWN_FILE, "utf8");

/** One column's information_schema shape, keyed by column name. */
type ColumnShape = { dataType: string; nullable: boolean };

run("narrators + narrator_chains migration (real Postgres, throwaway schema)", () => {
  let client: Awaited<ReturnType<typeof connectProbe>> | null = null;

  /** Run one statement on the probe session (search_path already set). */
  const query = async (text: string, params: unknown[] = []) => client!.query(text, params);

  /** The columns of one table in the probe schema, keyed by name. */
  const columnsOf = async (table: string): Promise<Record<string, ColumnShape>> => {
    const { rows } = await query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [SCHEMA, table],
    );
    return Object.fromEntries(
      rows.map((row: { column_name: string; data_type: string; is_nullable: string }) => [
        row.column_name,
        { dataType: row.data_type, nullable: row.is_nullable === "YES" },
      ]),
    );
  };

  const indexesOf = async (table: string): Promise<string[]> => {
    const { rows } = await query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
      [SCHEMA, table],
    );
    return rows.map((row: { indexname: string }) => row.indexname);
  };

  const columnNamesOf = async (table: string): Promise<string[]> => {
    const { rows } = await query(
      `SELECT attname FROM pg_attribute
       WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped
       ORDER BY attnum`,
      [table],
    );
    return rows.map((row: { attname: string }) => row.attname);
  };

  const tablesInSchema = async (): Promise<string[]> => {
    const { rows } = await query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [SCHEMA],
    );
    return rows.map((row: { table_name: string }) => row.table_name);
  };

  /** The text of an EXPLAIN plan as JSON, so a node name can be asserted by string. */
  const planOf = async (text: string, params: unknown[]): Promise<string> => {
    const { rows } = await query(`EXPLAIN (FORMAT JSON) ${text}`, params);
    return JSON.stringify(rows[0]);
  };

  beforeAll(async () => {
    if (!URL) return;
    client = await connectProbe(URL);
    // The probe session resolves every unqualified name through its own schema, so
    // the migration's `doc_children` reference hits the stub below, never the shared
    // table.
    await query(`CREATE SCHEMA ${SCHEMA}`);
    await query(`SET search_path TO ${SCHEMA}`);
    // A stand-in for the pre-existing table the migration must not rewrite: one
    // column the migration never mentions, holding a value it must not change.
    await query(
      `CREATE TABLE doc_children (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payload text)`,
    );
    await query(`INSERT INTO doc_children (id, payload) VALUES ($1, 'before-up')`, [CHILD_ID]);
  });

  afterAll(async () => {
    if (!URL) return;
    if (client !== null) {
      await client.query("RESET search_path").catch(() => {});
      client.release();
      client = null;
    }
    await postgresPool(URL)
      .query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      .catch(() => {});
    await disposePostgresPools();
  });

  it("applies additively: existing rows survive, the new tables are exactly the two", async () => {
    await query(upSql());
    // The row written before the migration is untouched: additive means no
    // rewrite of what already exists.
    expect(
      (await query(`SELECT payload FROM doc_children WHERE id = $1`, [CHILD_ID])).rows,
    ).toEqual([{ payload: "before-up" }]);
    // Additive means the existing table's shape is untouched too: no column was
    // added, dropped or retyped on the table the migration only references.
    expect(await columnNamesOf("doc_children")).toEqual(["id", "payload"]);
    // Compare as a set, sorted by code unit: the database's collation must not
    // decide whether this assertion passes.
    expect((await tablesInSchema()).sort()).toEqual([
      "doc_children",
      "narrator_chains",
      "narrators",
    ]);
  });

  it("owns the ticket's column shape, with only the bio/grade fields nullable", async () => {
    expect(await columnsOf("narrators")).toEqual({
      id: { dataType: "uuid", nullable: false },
      canonical_name_ar: { dataType: "text", nullable: false },
      name_variants: { dataType: "ARRAY", nullable: false },
      kunya: { dataType: "text", nullable: true },
      laqab: { dataType: "text", nullable: true },
      death_year: { dataType: "integer", nullable: true },
      tabaqa: { dataType: "text", nullable: true },
      reliability_by_critic: { dataType: "jsonb", nullable: false },
      metadata: { dataType: "jsonb", nullable: false },
      created_at: { dataType: "timestamp with time zone", nullable: false },
      updated_at: { dataType: "timestamp with time zone", nullable: false },
    });
    expect(await columnsOf("narrator_chains")).toEqual({
      id: { dataType: "uuid", nullable: false },
      child_id: { dataType: "uuid", nullable: false },
      collection: { dataType: "text", nullable: false },
      narrator_ids: { dataType: "ARRAY", nullable: false },
      grade: { dataType: "text", nullable: true },
      grader: { dataType: "text", nullable: true },
      source_ref: { dataType: "text", nullable: true },
      created_at: { dataType: "timestamp with time zone", nullable: false },
      updated_at: { dataType: "timestamp with time zone", nullable: false },
    });
  });

  it("indexes the two lookups the reads make: narrator names and chain -> child", async () => {
    expect(await indexesOf("narrators")).toEqual([
      "narrators_canonical_name_idx",
      "narrators_name_variants_gin",
      "narrators_pkey",
    ]);
    expect(await indexesOf("narrator_chains")).toEqual([
      "narrator_chains_child_id_idx",
      "narrator_chains_collection_idx",
      "narrator_chains_pkey",
    ]);
  });

  it("cascades a chain's removal from its child, and names the checks that guard it", async () => {
    const fk = await query(
      `SELECT c.confdeltype
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'narrator_chains' AND c.contype = 'f'`,
      [SCHEMA],
    );
    expect(fk.rows).toEqual([{ confdeltype: "c" }]);
    const checks = await query(
      `SELECT conname
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'narrator_chains' AND c.contype = 'c'
       ORDER BY conname`,
      [SCHEMA],
    );
    expect(checks.rows.map((row: { conname: string }) => row.conname)).toEqual([
      "narrator_chains_collection_nonempty",
      "narrator_chains_grade_attribution",
      "narrator_chains_grade_vocabulary",
      "narrator_chains_no_null_narrator",
      "narrator_chains_nonempty",
    ]);
  });

  it("stores the ordered chain exactly, duplicates included, and never merges same-name narrators", async () => {
    await query(
      `INSERT INTO narrators (id, canonical_name_ar, name_variants, kunya, laqab, death_year,
                              tabaqa, reliability_by_critic, metadata)
       VALUES ($1, 'أبو هريرة', ARRAY['ابو هريرة', 'Abu Hurayra'], 'أبو هريرة', NULL, 59,
               'sahaba', '{"ibn-hajar":{"verdict":"thiqa","sourceRef":"Taqrib"}}', '{"pfx":"mig"}'),
              ($2, 'أبو هريرة', ARRAY[]::text[], NULL, NULL, NULL, NULL, '{}'::jsonb, '{"pfx":"mig"}')`,
      [NARRATOR_A, NARRATOR_B],
    );
    // No UNIQUE on the canonical name: two narrators can share a name, and a
    // write-time merge would erase the ambiguity the resolution step settles.
    const sameName = await query(
      `SELECT count(*)::int AS n FROM narrators WHERE canonical_name_ar = $1`,
      ["أبو هريرة"],
    );
    expect(sameName.rows).toEqual([{ n: 2 }]);

    await query(
      `INSERT INTO narrator_chains (child_id, collection, narrator_ids, grade, grader, source_ref)
       VALUES ($1, 'bukhari', ARRAY[$2::uuid, $3::uuid, $2::uuid], 'sahih', 'al-bukhari', 'source:1')`,
      [CHILD_ID, NARRATOR_B, NARRATOR_A],
    );
    const stored = await query(
      `SELECT narrator_ids, grade, grader, source_ref FROM narrator_chains`,
    );
    expect(stored.rows).toEqual([
      {
        narrator_ids: [NARRATOR_B, NARRATOR_A, NARRATOR_B],
        grade: "sahih",
        grader: "al-bukhari",
        source_ref: "source:1",
      },
    ]);
    // The reliability map is stored verbatim, not reshaped by the database.
    const reliability = await query(`SELECT reliability_by_critic FROM narrators WHERE id = $1`, [
      NARRATOR_A,
    ]);
    expect(reliability.rows).toEqual([
      { reliability_by_critic: { "ibn-hajar": { verdict: "thiqa", sourceRef: "Taqrib" } } },
    ]);
  });

  it("admits exactly the domain pack's Grade vocabulary", async () => {
    // The domain pack's GRADES is the one list retrieval filters by; this CHECK is
    // its database twin. A fifth grade added to one without the other fails here.
    for (const grade of GRADES) {
      await query(
        `INSERT INTO narrator_chains (child_id, collection, narrator_ids, grade, grader, source_ref)
         VALUES ($1, 'bukhari', ARRAY[$2::uuid], $3, 'grader-a', 'grade-probe')`,
        [CHILD_ID, NARRATOR_A, grade],
      );
    }
    const stored = await query(
      `SELECT grade FROM narrator_chains WHERE source_ref = 'grade-probe'`,
    );
    expect(stored.rows.map((row: { grade: string }) => row.grade).sort()).toEqual(
      [...GRADES].sort(),
    );
  });

  it("rejects every stored shape a citation could misread", async () => {
    const chain = (narratorIds: string, grade: string | null, grader: string | null) =>
      query(
        `INSERT INTO narrator_chains (child_id, collection, narrator_ids, grade, grader)
         VALUES ($1, 'bukhari', ${narratorIds}, $2, $3)`,
        [CHILD_ID, grade, grader, NARRATOR_A],
      );

    await expect(
      query(
        `INSERT INTO narrator_chains (child_id, collection, narrator_ids, grade, grader)
         VALUES ($1, 'bukhari', ARRAY[]::uuid[], NULL, NULL)`,
        [CHILD_ID],
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      query(
        `INSERT INTO narrator_chains (child_id, collection, narrator_ids, grade, grader)
         VALUES ($1, 'bukhari', ARRAY[NULL]::uuid[], NULL, NULL)`,
        [CHILD_ID],
      ),
    ).rejects.toThrow(/check constraint/);
    // A grade outside CONTEXT.md's four, with its grader present, is still refused:
    // the vocabulary is the schema's, not the writer's.
    await expect(chain("ARRAY[$4::uuid]", "sahih ", "al-bukhari")).rejects.toThrow(
      /check constraint/,
    );
    // A grade without its grader is the unattributed claim ADR-0012 rejects, and
    // a grader without a grade states nothing.
    await expect(chain("ARRAY[$4::uuid]", "sahih", null)).rejects.toThrow(/check constraint/);
    await expect(chain("ARRAY[$4::uuid]", null, "al-bukhari")).rejects.toThrow(/check constraint/);
    // A blank grader is an unattributed grade wearing a string.
    await expect(chain("ARRAY[$4::uuid]", "sahih", " ")).rejects.toThrow(/check constraint/);
    await expect(
      query(
        `INSERT INTO narrator_chains (child_id, collection, narrator_ids, grade, grader)
         VALUES ($1, ' ', ARRAY[$2::uuid], NULL, NULL)`,
        [CHILD_ID, NARRATOR_A],
      ),
    ).rejects.toThrow(/check constraint/);

    await expect(query(`INSERT INTO narrators (canonical_name_ar) VALUES (' ')`)).rejects.toThrow(
      /check constraint/,
    );
    await expect(
      query(
        `INSERT INTO narrators (canonical_name_ar, name_variants) VALUES ('x', ARRAY[NULL]::text[])`,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      query(`INSERT INTO narrators (canonical_name_ar, death_year) VALUES ('x', 0)`),
    ).rejects.toThrow(/check constraint/);
  });

  it("deletes a child's chains with the child, and leaves the narrator catalogue standing", async () => {
    // The chain written by the ordered-round-trip case still hangs off the stub
    // child; the narrator rows are shared by every chain and outlive one.
    await query(`DELETE FROM doc_children WHERE id = $1`, [CHILD_ID]);
    expect((await query(`SELECT count(*)::int AS n FROM narrator_chains`)).rows).toEqual([
      { n: 0 },
    ]);
    expect((await query(`SELECT count(*)::int AS n FROM narrators`)).rows).toEqual([{ n: 2 }]);
  });

  it("makes the three reads' indexes usable (EXPLAIN sanity)", async () => {
    // Sequentially scanning a handful of rows is cheaper than any index, so the
    // planner would never show one at fixture size; disabling seq scans isolates
    // the claim being tested — the index CAN serve the predicate the read uses.
    // A few hundred rows so the name read's plan is decided by the indexes rather
    // than by a page-sized table: at fixture scale every plan is a scan.
    await query(
      `INSERT INTO narrators (canonical_name_ar, name_variants)
       SELECT 'probe-' || g, ARRAY['probe-variant-' || g] FROM generate_series(1, 500) g`,
    );
    await query(`SET enable_seqscan = off`);
    try {
      const byName = await planOf(
        `SELECT id FROM narrators
         WHERE canonical_name_ar = $1 OR name_variants @> ARRAY[$1]::text[]
         ORDER BY id LIMIT 5`,
        ["أبو هريرة"],
      );
      // Both branches are index-backed and the planner combines them: the OR is
      // not a seq scan over the catalogue.
      expect(byName).toContain("narrators_canonical_name_idx");
      expect(byName).toContain("narrators_name_variants_gin");
      expect(byName).not.toContain("Seq Scan");

      await query(`SET enable_bitmapscan = off`);
      const childChains = await planOf(
        `SELECT id FROM narrator_chains WHERE child_id = $1 ORDER BY created_at, id LIMIT 10`,
        [CHILD_ID],
      );
      expect(childChains).toContain("narrator_chains_child_id_idx");
      // Filter and order in one index scan: the composite exists so a child's
      // chains never need a sort (which would be a ranking the store must not imply).
      expect(childChains).not.toContain("Sort");
      await query(`SET enable_bitmapscan = on`);

      const page = await planOf(
        `SELECT id FROM narrator_chains
         WHERE collection = $1 AND id > $2::uuid ORDER BY id LIMIT 10`,
        ["bukhari", "00000000-0000-4000-8000-000000000000"],
      );
      expect(page).toContain("narrator_chains_collection_idx");
    } finally {
      await query(`SET enable_seqscan = on`);
    }
  });

  it("rolls back cleanly: only the new objects go, and pre-existing data stays", async () => {
    // The cascade case removed the original stub row; a fresh one stands in for
    // "data that existed before the migration" at rollback time.
    await query(
      `INSERT INTO doc_children (id, payload) VALUES ($1, 'before-down') ON CONFLICT (id) DO NOTHING`,
      [CHILD_ID],
    );
    await query(downSql());
    expect(await tablesInSchema()).toEqual(["doc_children"]);
    const child = await query(`SELECT payload FROM doc_children WHERE id = $1`, [CHILD_ID]);
    expect(child.rows).toEqual([{ payload: "before-down" }]);
    expect(await columnNamesOf("doc_children")).toEqual(["id", "payload"]);
  });
});
