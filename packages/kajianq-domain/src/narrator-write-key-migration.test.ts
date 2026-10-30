// @requires-postgres
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { disposePostgresPools, postgresPool } from "@app/infra";

/**
 * Migration 0004: the natural keys the write seam relies on, against real Postgres.
 *
 * Test intent, named before the assertions:
 * - trap: the write path's idempotency is only as strong as the database's unique
 *   indexes. The two indexes are asserted to refuse a duplicate key and to allow the
 *   rows a key cannot address (NULL identity, NULL source address), so a race between
 *   two writers fails loudly instead of writing a second row;
 * - trap: the migration must be additive. Rows written before `up` survive it, and
 *   survive the `down` that drops only what the migration added;
 * - trap: the chain index is collection-scoped. The same source address in another
 *   collection is a different chain — a global index would refuse a second book's row.
 *
 * Everything runs in a throwaway schema with stub tables, the same bytes `db:up:domain`
 * applies; the shared schema and the ledger stay untouched.
 */

const URL = process.env.DATABASE_URL;
const run = URL ? describe : describe.skip;

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const UP_FILE = join(MIGRATIONS, "0004_narrator_write_keys.sql");
const DOWN_FILE = join(MIGRATIONS, "0004_narrator_write_keys.down.sql");
const SCHEMA = `write_key_probe_${Math.random().toString(36).slice(2, 10)}`;
const NARRATOR_ID = "00000000-0000-4000-8000-0000000000d1";
const CHAIN_ID = "00000000-0000-4000-8000-0000000000d2";

async function connectProbe(connectionString: string) {
  return postgresPool(connectionString).connect();
}

run("narrator write keys migration (real Postgres, throwaway schema)", () => {
  let client: Awaited<ReturnType<typeof connectProbe>> | null = null;

  const query = async (text: string, params: unknown[] = []) => client!.query(text, params);

  const refusedBy = async (write: Promise<unknown>): Promise<string | undefined> => {
    try {
      await write;
      return undefined;
    } catch (error) {
      return (error as { constraint?: string }).constraint;
    }
  };

  const indexesOf = async (table: string): Promise<string[]> => {
    const { rows } = await query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
      [SCHEMA, table],
    );
    return rows.map((row: { indexname: string }) => row.indexname);
  };

  beforeAll(async () => {
    if (!URL) return;
    client = await connectProbe(URL);
    await query(`CREATE SCHEMA ${SCHEMA}`);
    await query(`SET search_path TO ${SCHEMA}`);
    // The stubs are the shape 0003 leaves behind: the columns 0004 adds a key to,
    // plus one column it must never touch.
    await query(`CREATE TABLE narrators (
                   id uuid PRIMARY KEY,
                   canonical_name_ar text NOT NULL,
                   payload text
                 )`);
    await query(`CREATE TABLE narrator_chains (
                   id uuid PRIMARY KEY,
                   collection text NOT NULL,
                   source_ref text NULL,
                   payload text
                 )`);
    await query(
      `INSERT INTO narrators (id, canonical_name_ar, payload) VALUES ($1, 'n', 'before-up')`,
      [NARRATOR_ID],
    );
    await query(
      `INSERT INTO narrator_chains (id, collection, payload) VALUES ($1, 'c', 'before-up')`,
      [CHAIN_ID],
    );
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

  it("adds the two natural keys without rewriting what is stored", async () => {
    await query(readFileSync(UP_FILE, "utf8"));
    expect(
      (await query(`SELECT payload FROM narrators WHERE id = $1`, [NARRATOR_ID])).rows[0],
    ).toEqual({ payload: "before-up" });
    expect(
      (await query(`SELECT payload FROM narrator_chains WHERE id = $1`, [CHAIN_ID])).rows[0],
    ).toEqual({ payload: "before-up" });

    expect(await indexesOf("narrators")).toEqual(
      expect.arrayContaining(["narrators_identity_key_idx"]),
    );
    expect(await indexesOf("narrator_chains")).toEqual(
      expect.arrayContaining(["narrator_chains_source_ref_idx"]),
    );
    // A pre-existing narrator holds a NULL key: the index must accept many of them.
    const { rows } = await query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'narrator_chains_source_ref_idx'`,
      [SCHEMA],
    );
    expect(rows[0]?.indexdef).toContain("WHERE (source_ref IS NOT NULL)");
  });

  it("refuses a duplicate identity key and a duplicate chain address", async () => {
    const second = "00000000-0000-4000-8000-0000000000d3";
    await query(`UPDATE narrators SET identity_key = 'narrator:key:1' WHERE id = $1`, [
      NARRATOR_ID,
    ]);
    expect(
      await refusedBy(
        query(
          `INSERT INTO narrators (id, canonical_name_ar, identity_key)
               VALUES ($1, 'n2', 'narrator:key:1')`,
          [second],
        ),
      ),
    ).toBe("narrators_identity_key_idx");
    // A NULL key is not a key: more than one row may carry none.
    await query(`UPDATE narrators SET identity_key = NULL WHERE id = $1`, [NARRATOR_ID]);
    await query(`INSERT INTO narrators (id, canonical_name_ar) VALUES ($1, 'n3')`, [second]);
    await query(`DELETE FROM narrators WHERE id = $1`, [second]);

    await query(`UPDATE narrator_chains SET source_ref = 'sanadset:row:1' WHERE id = $1`, [
      CHAIN_ID,
    ]);
    expect(
      await refusedBy(
        query(
          `INSERT INTO narrator_chains (id, collection, source_ref)
               VALUES ($1, 'c', 'sanadset:row:1')`,
          ["00000000-0000-4000-8000-0000000000d4"],
        ),
      ),
    ).toBe("narrator_chains_source_ref_idx");
    // The same address in another collection is another chain.
    await query(
      `INSERT INTO narrator_chains (id, collection, source_ref) VALUES ($1, 'other', 'sanadset:row:1')`,
      ["00000000-0000-4000-8000-0000000000d5"],
    );
    // A NULL address is not an address: more than one row may carry none.
    await query(`INSERT INTO narrator_chains (id, collection) VALUES ($1, 'c')`, [
      "00000000-0000-4000-8000-0000000000d6",
    ]);
    await query(`INSERT INTO narrator_chains (id, collection) VALUES ($1, 'c')`, [
      "00000000-0000-4000-8000-0000000000d7",
    ]);
  });

  it("rolls back cleanly: only the keys leave, the rows stay", async () => {
    await query(readFileSync(DOWN_FILE, "utf8"));
    expect(await indexesOf("narrators")).not.toContain("narrators_identity_key_idx");
    expect(await indexesOf("narrator_chains")).not.toContain("narrator_chains_source_ref_idx");
    const columns = await query(
      `SELECT attname FROM pg_attribute WHERE attrelid = 'narrators'::regclass
       AND attnum > 0 AND NOT attisdropped`,
    );
    expect(columns.rows.map((row: { attname: string }) => row.attname)).not.toContain(
      "identity_key",
    );
    expect(
      (await query(`SELECT payload FROM narrators WHERE id = $1`, [NARRATOR_ID])).rows[0],
    ).toEqual({ payload: "before-up" });
    expect((await query(`SELECT count(*)::int AS n FROM narrator_chains`)).rows[0]).toEqual({
      n: 4,
    });
  });
});
