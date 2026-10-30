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
import { createMemoryRagStore } from "./test-utils/memory-rag-store";

/**
 * The narrator/chain write seam: the adapter and the in-memory double answer the
 * same thing.
 *
 * Test intent, named before the assertions:
 * - trap: identity is claimed by the caller's key, never by the name. Two keys with
 *   the same canonical name must stay two rows — a store that collapses them by name
 *   silently merges two people;
 * - trap: a variant list grows by union, and a later write that omits a column must
 *   not erase it. Both are asserted after a second upsert of the same key;
 * - trap: the chain's natural key is `(collection, source_ref)`. Re-upserting the same
 *   address must update its child, not add a row, while the same address in another
 *   collection is another row — a key that ignored the collection would move an isnad
 *   between books;
 * - trap: the seam's refusals are uniform. Every malformed row is asserted to fail as
 *   a `constraint` error in both stores, and the counts afterwards are asserted
 *   unchanged, so a refusal can never be a partially written row.
 */

const URL = process.env.DATABASE_URL;
const run = URL ? describe : describe.skip;

const PREFIX = `nw${Math.random().toString(36).slice(2, 8)}`;
const NAME = "زيد بن ثابت الأنصاري";
const OTHER_NAME = "أبو سعيد الخدري";

run("narrator and chain writes (real Postgres, memory parity)", () => {
  let sql: ReturnType<typeof postgresSqlRunner> | null = null;
  let pg: RagStore | null = null;
  let memory: RagStore | null = null;
  let pgChildren: readonly string[] = [];
  let memoryChildren: readonly string[] = [];

  const stores = (): { pg: RagStore; memory: RagStore } => {
    if (!pg || !memory) throw new Error("stores not initialised");
    return { pg, memory };
  };

  /** Run one effect against both stores; each store's own child ids are passed in. */
  const onBoth = async <T>(
    fn: (store: RagStore, childIds: readonly string[]) => Effect.Effect<T, unknown>,
  ): Promise<[T, T]> => {
    const { pg: pgStore, memory: memoryStore } = stores();
    const postgres = await Effect.runPromise(fn(pgStore, pgChildren));
    const doubled = await Effect.runPromise(fn(memoryStore, memoryChildren));
    return [postgres, doubled];
  };

  const chainCount = async (collection: string): Promise<number> => {
    const rows = (await sql!`SELECT count(*)::int AS n FROM narrator_chains
                             WHERE collection = ${collection}`) as { n: number }[];
    return rows[0]?.n ?? -1;
  };

  beforeAll(async () => {
    if (!URL) return;
    sql = postgresSqlRunner(postgresPool(URL));
    pg = createPostgresRagStore(sql);
    memory = createMemoryRagStore();
    for (const store of [pg, memory]) {
      const parentId = await Effect.runPromise(
        store.insertDocParent({
          sourceKey: `${PREFIX}-parent`,
          title: PREFIX,
          metadata: { pfx: PREFIX },
        }),
      );
      const ids = await Effect.runPromise(
        store.insertDocChildren(
          [0, 1].map((ordinal) => ({
            parentId,
            textRaw: `${PREFIX}-raw-${ordinal}`,
            textAr: `${PREFIX}-ar-${ordinal}`,
            textId: null,
            embeddingPrimary: null,
            embeddingFallback: null,
            ordinal,
            metadata: { pfx: PREFIX },
          })),
        ),
      );
      if (store === pg) pgChildren = ids;
      else memoryChildren = ids;
    }
  });

  afterAll(async () => {
    if (!URL || sql === null) return;
    await sql`DELETE FROM narrator_chains WHERE collection LIKE ${`${PREFIX}%`}`;
    await sql`DELETE FROM narrators WHERE identity_key LIKE ${`${PREFIX}%`}`;
    await sql`DELETE FROM doc_parents WHERE source_key = ${`${PREFIX}-parent`}`;
    await disposePostgresPools();
  });

  it("keys identity by the caller's key, not by the name", async () => {
    const [postgres, doubled] = await onBoth((store) =>
      Effect.gen(function* () {
        const one = yield* store.upsertNarrator({
          identityKey: `${PREFIX}:one`,
          canonicalNameAr: NAME,
        });
        const two = yield* store.upsertNarrator({
          identityKey: `${PREFIX}:two`,
          canonicalNameAr: NAME,
        });
        const again = yield* store.upsertNarrator({
          identityKey: `${PREFIX}:one`,
          canonicalNameAr: NAME,
          deathYear: 101,
        });
        return { one, two, again };
      }),
    );
    for (const result of [postgres, doubled]) {
      expect(result.one.id).toBe(result.again.id);
      expect(result.two.id).not.toBe(result.one.id);
      expect(result.again.deathYear).toBe(101);
      expect(result.one.canonicalNameAr).toBe(NAME);
    }
    const rows = (await sql!`SELECT count(*)::int AS n FROM narrators
                             WHERE identity_key IN (${`${PREFIX}:one`}, ${`${PREFIX}:two`})`) as {
      n: number;
    }[];
    expect(rows[0]?.n).toBe(2);
  });

  it("unions variants and keeps a column a later write omits", async () => {
    const [postgres, doubled] = await onBoth((store) =>
      Effect.gen(function* () {
        const one = yield* store.upsertNarrator({
          identityKey: `${PREFIX}:merge`,
          canonicalNameAr: OTHER_NAME,
          nameVariants: ["أبو سعيد"],
          kunya: "أبو سعيد",
        });
        const two = yield* store.upsertNarrator({
          identityKey: `${PREFIX}:merge`,
          canonicalNameAr: OTHER_NAME,
          nameVariants: ["أبو سعيد", "سعيد بن مالك"],
        });
        return { one, two };
      }),
    );
    for (const result of [postgres, doubled]) {
      expect(result.two.id).toBe(result.one.id);
      expect(result.two.nameVariants).toEqual(["أبو سعيد", "سعيد بن مالك"]);
      expect(result.two.kunya).toBe("أبو سعيد");
    }
  });

  it("updates a chain on its source address instead of duplicating it", async () => {
    const [postgres, doubled] = await onBoth((store, childIds) =>
      Effect.gen(function* () {
        const narrator = yield* store.upsertNarrator({
          identityKey: `${PREFIX}:chain`,
          canonicalNameAr: NAME,
        });
        const first = yield* store.insertNarratorChains([
          {
            childId: childIds[0]!,
            collection: `${PREFIX}-c`,
            narratorIds: [narrator.id],
            sourceRef: `${PREFIX}:row:1`,
          },
        ]);
        const moved = yield* store.insertNarratorChains([
          {
            childId: childIds[1]!,
            collection: `${PREFIX}-c`,
            narratorIds: [narrator.id],
            sourceRef: `${PREFIX}:row:1`,
          },
        ]);
        const otherCollection = yield* store.insertNarratorChains([
          {
            childId: childIds[1]!,
            collection: `${PREFIX}-d`,
            narratorIds: [narrator.id],
            sourceRef: `${PREFIX}:row:1`,
          },
        ]);
        // A chain the source does not address has no natural key: two writes are two rows.
        const unaddressed = yield* store.insertNarratorChains([
          {
            childId: childIds[0]!,
            collection: `${PREFIX}-null`,
            narratorIds: [narrator.id],
            sourceRef: null,
          },
          {
            childId: childIds[1]!,
            collection: `${PREFIX}-null`,
            narratorIds: [narrator.id],
            sourceRef: null,
          },
        ]);
        const read = yield* store.listChainsByCollection(`${PREFIX}-c`, { limit: 10 });
        return { first, moved, otherCollection, unaddressed, read: read.rows, childIds };
      }),
    );
    for (const result of [postgres, doubled]) {
      expect(result.first[0]).toBe(result.moved[0]);
      expect(result.otherCollection[0]).not.toBe(result.first[0]);
      expect(result.read).toHaveLength(1);
      expect(result.read[0]).toMatchObject({
        childId: result.childIds[1],
        collection: `${PREFIX}-c`,
        grade: null,
        grader: null,
        sourceRef: `${PREFIX}:row:1`,
      });
      expect(result.unaddressed).toHaveLength(2);
      expect(result.unaddressed[0]).not.toBe(result.unaddressed[1]);
    }
    expect(await chainCount(`${PREFIX}-c`)).toBe(1);
    expect(await chainCount(`${PREFIX}-d`)).toBe(1);
    expect(await chainCount(`${PREFIX}-null`)).toBe(2);
  });

  it("refuses every malformed row as a constraint error in both stores", async () => {
    const badNarrators = [
      { identityKey: "", canonicalNameAr: NAME },
      { identityKey: `${PREFIX}:bad`, canonicalNameAr: "" },
      { identityKey: `${PREFIX}:bad`, canonicalNameAr: NAME, deathYear: 0 },
      {
        identityKey: `${PREFIX}:bad`,
        canonicalNameAr: NAME,
        reliabilityByCritic: { "": "thiqah" },
      },
    ];
    const badChains = (narratorIds: readonly string[], childIds: readonly string[]) => [
      {
        childId: "",
        collection: `${PREFIX}-bad`,
        narratorIds: [narratorIds[0]!],
        sourceRef: `${PREFIX}:b:1`,
      },
      {
        childId: childIds[0]!,
        collection: "",
        narratorIds: [narratorIds[0]!],
        sourceRef: `${PREFIX}:b:2`,
      },
      {
        childId: childIds[0]!,
        collection: `${PREFIX}-bad`,
        narratorIds: [],
        sourceRef: `${PREFIX}:b:3`,
      },
      {
        childId: childIds[0]!,
        collection: `${PREFIX}-bad`,
        narratorIds: [narratorIds[0]!],
        sourceRef: `${PREFIX}:b:5`,
        grade: "sahih",
      },
      {
        childId: childIds[0]!,
        collection: `${PREFIX}-bad`,
        narratorIds: [narratorIds[0]!],
        sourceRef: "",
      },
      {
        childId: childIds[0]!,
        collection: `${PREFIX}-bad`,
        narratorIds: [narratorIds[0]!],
        grade: "sahih",
        grader: "",
        sourceRef: `${PREFIX}:b:4`,
      },
    ];
    const { pg: pgStore, memory: memoryStore } = stores();
    for (const store of [pgStore, memoryStore]) {
      for (const input of badNarrators) {
        const error = await Effect.runPromise(Effect.flip(store.upsertNarrator(input)));
        expect(error.kind).toBe("constraint");
      }
      const narrator = await Effect.runPromise(
        store.upsertNarrator({ identityKey: `${PREFIX}:ok`, canonicalNameAr: NAME }),
      );
      const childIds = store === pgStore ? pgChildren : memoryChildren;
      for (const input of badChains([narrator.id], childIds)) {
        const error = await Effect.runPromise(Effect.flip(store.insertNarratorChains([input])));
        expect(error.kind).toBe("constraint");
      }
    }
    expect(await chainCount(`${PREFIX}-bad`)).toBe(0);
  });

  it("answers the same chain and narrator records from both stores", async () => {
    const [postgres, doubled] = await onBoth((store, childIds) =>
      Effect.gen(function* () {
        const narrator = yield* store.upsertNarrator({
          identityKey: `${PREFIX}:parity`,
          canonicalNameAr: NAME,
          nameVariants: ["زيد بن ثابت"],
          kunya: "أبو سعيد",
        });
        yield* store.insertNarratorChains([
          {
            childId: childIds[0]!,
            collection: `${PREFIX}-parity`,
            narratorIds: [narrator.id],
            sourceRef: `${PREFIX}:parity:row`,
          },
        ]);
        const chain = yield* store.listChainsByCollection(`${PREFIX}-parity`, { limit: 10 });
        const read = yield* store.getNarratorsByIds([narrator.id]);
        return { chain: chain.rows, narrator: read.narrators, missing: read.missingIds };
      }),
    );
    const shape = (result: typeof postgres) => ({
      chains: result.chain.map((chain) => ({
        collection: chain.collection,
        grade: chain.grade,
        grader: chain.grader,
        sourceRef: chain.sourceRef,
        narratorCount: chain.narratorIds.length,
      })),
      narrators: result.narrator.map((narrator) => ({
        canonicalNameAr: narrator.canonicalNameAr,
        nameVariants: narrator.nameVariants,
        kunya: narrator.kunya,
      })),
      missing: result.missing,
    });
    expect(shape(doubled)).toEqual(shape(postgres));
  });
});
