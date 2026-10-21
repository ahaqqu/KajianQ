// @requires-postgres
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  createPostgresRagStore,
  disposePostgresPools,
  postgresPool,
  postgresSqlRunner,
  type RagStore,
} from "@app/infra";
import { createMemoryRagStore } from "./memory-rag-store";

/**
 * The memory stand-in's corpus reads, held to the adapter's own semantics.
 *
 * A double more forgiving than the read it stands in for is a gate that cannot go red:
 * the neighbour expansion's cap was starved for exactly that reason, because the double
 * answered a different question than the SQL. These cases pin the three reads whose
 * stand-in used to disagree — the filter predicate, the metadata count, and the by-id
 * read's order — and, when `DATABASE_URL` is set, run the same calls through the real
 * adapter so the two answers are compared rather than assumed equal.
 */

const URL = process.env.DATABASE_URL;
const FIXTURE_SCOPE = "fidelity/corpus";

type CorpusStore = Pick<
  RagStore,
  | "insertDocParent"
  | "insertDocChildren"
  | "listDocChildrenByParentSourceKey"
  | "similaritySearch"
  | "countDocChildrenByMetadata"
  | "findDocChildrenByMetadata"
  | "getDocChildrenByIds"
>;

const DIM = 1536;
const QUERY = Array.from({ length: DIM }, (_, i) => Math.sin(100 * 1000 + i * 0.01));

/**
 * Five rows covering the shapes `metadata->>key` can take: a string value, a number
 * where a string is expected, an absent key, and a second string value. Distinct
 * embeddings so the search's order is the fixture's, not a tie-break.
 */
function fixtureChildren(parentId: string) {
  const row = (ordinal: number, metadata: Record<string, unknown>) => ({
    parentId,
    textRaw: `raw-${ordinal}`,
    textAr: `ar-${ordinal}`,
    textId: `id-${ordinal}`,
    citation: { fixture: "fidelity", ordinal },
    embeddingPrimary: Array.from({ length: DIM }, (_, i) =>
      Math.sin((100 + ordinal) * 1000 + i * 0.01),
    ),
    embeddingFallback: null,
    ordinal,
    metadata,
  });
  return [
    row(0, { sourceType: "hadith", collection: "malik" }),
    row(1, { sourceType: "quran", collection: 7 }),
    row(2, { sourceType: "quran" }),
    row(3, { sourceType: "quran", collection: "malik" }),
    row(4, { sourceType: "quran", collection: "bukhari" }),
  ];
}

async function seed(store: CorpusStore, sourceKey: string): Promise<void> {
  const parentId = await Effect.runPromise(
    store.insertDocParent({ sourceKey, title: sourceKey, metadata: { pfx: sourceKey } }),
  );
  await Effect.runPromise(store.insertDocChildren(fixtureChildren(parentId)));
}

async function ordinalsById(store: CorpusStore, sourceKey: string): Promise<Map<number, string>> {
  const rows = await Effect.runPromise(
    store.listDocChildrenByParentSourceKey(sourceKey, { limit: 10 }),
  );
  return new Map(rows.map((r) => [r.ordinal, r.id]));
}

describe("the memory stand-in's corpus reads answer what the adapter's SQL answers", () => {
  async function storeWithFixture() {
    const store = createMemoryRagStore();
    await seed(store, FIXTURE_SCOPE);
    const byOrdinal = await ordinalsById(store, FIXTURE_SCOPE);
    const idToOrdinal = new Map([...byOrdinal].map(([ordinal, id]) => [id, ordinal]));
    const searchOrdinals = async (
      filters?: Record<string, string | readonly string[]>,
    ): Promise<number[]> => {
      const hits = await Effect.runPromise(
        store.similaritySearch("primary", QUERY, { limit: 10, ...(filters ? { filters } : {}) }),
      );
      return hits.map((hit) => idToOrdinal.get(hit.child.id) ?? -1).sort((a, b) => a - b);
    };
    return { store, byOrdinal, searchOrdinals };
  }

  it("binds `filters` as the adapter's `metadata->>key = ANY(values)` predicate", async () => {
    const { searchOrdinals } = await storeWithFixture();
    // No filter record constrains nothing; an empty one is the same read.
    expect(await searchOrdinals()).toEqual([0, 1, 2, 3, 4]);
    expect(await searchOrdinals({})).toEqual([0, 1, 2, 3, 4]);
    // One dimension, a set of values, exact match on the key's JSON text.
    expect(await searchOrdinals({ sourceType: ["quran"] })).toEqual([1, 2, 3, 4]);
    expect(await searchOrdinals({ collection: ["malik"] })).toEqual([0, 3]);
    // A number's `->>` text is the number as text, so a string filter finds it.
    expect(await searchOrdinals({ collection: ["7"] })).toEqual([1]);
    // The absent key cannot equal any value, and dimensions AND together.
    expect(await searchOrdinals({ sourceType: ["quran"], collection: ["malik"] })).toEqual([3]);
    expect(await searchOrdinals({ sourceType: ["sahih"] })).toEqual([]);
  });

  it("counts only rows whose key holds a string, with no `null` group", async () => {
    const { store } = await storeWithFixture();
    const counts = await Effect.runPromise(store.countDocChildrenByMetadata("collection"));
    // The number at ordinal 1 and the absent key at ordinal 2 are not counted at all:
    // the adapter's WHERE clause reads `metadata ? $1 AND jsonb_typeof(...) = 'string'`.
    expect(counts).toEqual([
      { value: "malik", count: 2 },
      { value: "bukhari", count: 1 },
    ]);
  });

  it("matches metadata by JSON scalar, as the adapter's containment predicate does", async () => {
    const { store, byOrdinal } = await storeWithFixture();
    const idToOrdinal = new Map([...byOrdinal].map(([ordinal, id]) => [id, ordinal]));
    const ordinals = async (match: Record<string, string | number>): Promise<number[]> =>
      (await Effect.runPromise(store.findDocChildrenByMetadata(match, { limit: 10 })))
        .map((row) => idToOrdinal.get(row.id) ?? -1)
        .sort((a, b) => a - b);
    expect(await ordinals({ collection: "malik" })).toEqual([0, 3]);
    // A number in `metadata` is not its text: containment compares the JSON
    // scalars, unlike the `->>` filter predicate, which stringifies them.
    expect(await ordinals({ collection: 7 })).toEqual([1]);
    expect(await ordinals({ collection: "7" })).toEqual([]);
    // Dimensions AND together, the absent key matches nothing, and an empty
    // match is not a read.
    expect(await ordinals({ sourceType: "quran", collection: "malik" })).toEqual([3]);
    expect(await ordinals({ collection: "sahih" })).toEqual([]);
    expect(await ordinals({})).toEqual([]);
  });

  it("returns the by-id read in the store's order, not the caller's", async () => {
    const { store, byOrdinal } = await storeWithFixture();
    const ordered = [0, 1, 2, 3, 4].map((ordinal) => byOrdinal.get(ordinal) as string);
    const asked = [ordered[4] as string, ordered[0] as string, ordered[2] as string];
    // The adapter's read carries no ORDER BY, so echoing the caller's array back would
    // promise an order the real read never makes.
    expect((await Effect.runPromise(store.getDocChildrenByIds(asked))).map((r) => r.id)).toEqual([
      ordered[0],
      ordered[2],
      ordered[4],
    ]);
    // Deduplicated, and an id no row backs is simply missing.
    const absent = "00000000-0000-4000-8000-000000000000";
    expect(
      (
        await Effect.runPromise(
          store.getDocChildrenByIds([ordered[1] as string, ordered[1] as string, absent]),
        )
      ).map((r) => r.id),
    ).toEqual([ordered[1]]);
  });
});

const pgRun = URL ? describe : describe.skip;

pgRun("the memory stand-in and the adapter agree on one fixture (real Postgres)", () => {
  let prefix = "";
  let sql: ReturnType<typeof postgresSqlRunner> | null = null;
  let pg: ReturnType<typeof createPostgresRagStore> | null = null;
  let mem: ReturnType<typeof createMemoryRagStore> | null = null;
  let pgByOrdinal = new Map<number, string>();
  let memByOrdinal = new Map<number, string>();

  beforeAll(async () => {
    if (!URL) return;
    prefix = `ct-fidelity-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    sql = postgresSqlRunner(postgresPool(URL));
    pg = createPostgresRagStore(sql);
    mem = createMemoryRagStore();
    await seed(pg, prefix);
    await seed(mem, prefix);
    pgByOrdinal = await ordinalsById(pg, prefix);
    memByOrdinal = await ordinalsById(mem, prefix);
  });

  afterAll(async () => {
    if (!URL || sql === null) return;
    // The exact key, so the shared database keeps only the rows this block owns.
    await sql`DELETE FROM doc_children WHERE parent_id IN (
      SELECT id FROM doc_parents WHERE source_key = ${prefix}
    )`;
    await sql`DELETE FROM doc_parents WHERE source_key = ${prefix}`;
    await disposePostgresPools();
  });

  it("filters, counts and fetches the same rows on both sides", async () => {
    if (pg === null || mem === null) return;
    const searchOrdinals = (store: CorpusStore, byOrdinal: Map<number, string>) => {
      const idToOrdinal = new Map([...byOrdinal].map(([ordinal, id]) => [id, ordinal]));
      return async (filters?: Record<string, string | readonly string[]>) => {
        const hits = await Effect.runPromise(
          store.similaritySearch("primary", QUERY, { limit: 10, ...(filters ? { filters } : {}) }),
        );
        return hits.map((hit) => idToOrdinal.get(hit.child.id) ?? -1).sort((a, b) => a - b);
      };
    };
    const memorySearch = searchOrdinals(mem, memByOrdinal);
    const adapterSearch = searchOrdinals(pg, pgByOrdinal);
    for (const filters of [
      undefined,
      {},
      { sourceType: ["quran"] },
      { collection: ["7"] },
      { sourceType: ["quran"], collection: ["malik"] },
      { sourceType: ["sahih"] },
    ]) {
      const label = `filters ${JSON.stringify(filters)}`;
      expect(await memorySearch(filters), label).toEqual(await adapterSearch(filters));
    }
    const counts = async (store: CorpusStore) =>
      [...(await Effect.runPromise(store.countDocChildrenByMetadata("collection")))].sort(
        (a, b) => b.count - a.count || (a.value ?? "").localeCompare(b.value ?? ""),
      );
    expect(await counts(mem)).toEqual(await counts(pg));
    // No order is promised by either read, so the comparison is the row set — in
    // ordinals, because the two stores mint their own ids.
    const byIds = async (store: CorpusStore, byOrdinal: Map<number, string>) => {
      const idToOrdinal = new Map([...byOrdinal].map(([ordinal, id]) => [id, ordinal]));
      return (
        await Effect.runPromise(
          store.getDocChildrenByIds([
            byOrdinal.get(4) as string,
            byOrdinal.get(0) as string,
            byOrdinal.get(2) as string,
          ]),
        )
      )
        .map((r) => idToOrdinal.get(r.id) ?? -1)
        .sort((a, b) => a - b);
    };
    expect(await byIds(mem, memByOrdinal)).toEqual(await byIds(pg, pgByOrdinal));
  });

  it("matches the same metadata pairs on both sides", async () => {
    if (pg === null || mem === null) return;
    const matched = async (store: CorpusStore, byOrdinal: Map<number, string>) => {
      const idToOrdinal = new Map([...byOrdinal].map(([ordinal, id]) => [id, ordinal]));
      const rows = await Effect.runPromise(
        store.findDocChildrenByMetadata({ collection: "malik" }, { limit: 10 }),
      );
      return rows.map((row) => idToOrdinal.get(row.id) ?? -1).sort((a, b) => a - b);
    };
    expect(await matched(mem, memByOrdinal)).toEqual([0, 3]);
    expect(await matched(pg, pgByOrdinal)).toEqual([0, 3]);
  });

  it("reads the same ordinal window from a fromOrdinal lower bound", async () => {
    if (pg === null || mem === null) return;
    const window = async (store: CorpusStore, byOrdinal: Map<number, string>) => {
      const idToOrdinal = new Map([...byOrdinal].map(([ordinal, id]) => [id, ordinal]));
      const rows = await Effect.runPromise(
        store.listDocChildrenByParentSourceKey(prefix, { limit: 2, fromOrdinal: 2 }),
      );
      return rows.map((r) => idToOrdinal.get(r.id) ?? -1);
    };
    // The bound's own row is included and everything before it is not, on both
    // sides — the window start the scope read depends on has one meaning.
    expect(await window(mem, memByOrdinal)).toEqual([2, 3]);
    expect(await window(pg, pgByOrdinal)).toEqual([2, 3]);
    // A bound past the parent's last ordinal is empty on both sides.
    const past = { limit: 5, fromOrdinal: 9 } as const;
    expect(await Effect.runPromise(mem.listDocChildrenByParentSourceKey(prefix, past))).toEqual([]);
    expect(await Effect.runPromise(pg.listDocChildrenByParentSourceKey(prefix, past))).toEqual([]);
  });
});
