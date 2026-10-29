// @requires-postgres
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import {
  createPostgresRagStore,
  disposePostgresPools,
  postgresPool,
  postgresSqlRunner,
  type NarratorRecord,
  type RagStore,
} from "@app/infra";
import { runFail } from "@app/rag-core/testing";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";
import type { SeededChain } from "./test-utils/memory-rag-store-parts";

/**
 * The narrator/chain reads on real Postgres, held to the in-memory double.
 *
 * The property under test is a **lossless read**: the ordered narrator sequence
 * (duplicates included), the grade with its grader, the critic map and the name
 * variants come back exactly as stored, and an id a chain names but the catalogue
 * does not hold is reported rather than dropped. A read that sorted, deduped or
 * normalised would still look green in a UI test while rewriting the transmission
 * it reports, so every case below is an exact-value assertion.
 *
 * The same fixture is seeded into both implementations and every read is compared
 * before it is asserted: a double more forgiving than the SQL is a gate that
 * cannot go red, and the memory store is what every DB-less test sees.
 *
 * The suite lives in the domain pack because its fixture uses the real Grade
 * vocabulary — the engine seam may not name it, and that is exactly what the
 * contract proves: the adapter validates no grade, it returns the string it
 * stored.
 */

const URL = process.env.DATABASE_URL;
const run = URL ? describe : describe.skip;

let PREFIX: string;
let sql: ReturnType<typeof postgresSqlRunner> | null = null;
let postgres: RagStore;
let memory: ReturnType<typeof createMemoryRagStore>;

const NARRATOR_ONE = "11111111-1111-4111-8111-111111111111";
const NARRATOR_TWO = "22222222-2222-4222-8222-222222222222";
const NARRATOR_THREE = "33333333-3333-4333-8333-333333333333";
const NARRATOR_FOUR = "44444444-4444-4444-8444-444444444444";
const NARRATOR_UNKNOWN = "99999999-9999-4999-8999-999999999999";
const CHILD_MISSING = "88888888-8888-4888-8888-888888888888";

const NAME_ONE = "الاسم الأول";
const NAME_ONE_FOLDED = "الاسم الاول";
const NAME_THREE = "الاسم الثالث";
const NAME_FOUR = "الاسم الرابع";

/** The fixture's chain ids, assigned in id order so the keyset page is predictable. */
let chainIds: string[] = [];
/** The child ids the fixture's parent holds, in ordinal order. */
let childIds: readonly string[] = [];

function narratorFixture(): NarratorRecord[] {
  return [
    {
      id: NARRATOR_ONE,
      canonicalNameAr: NAME_ONE,
      nameVariants: [NAME_ONE_FOLDED, "Name One"],
      kunya: "أبو أحد",
      laqab: "الأول",
      deathYear: 59,
      tabaqa: "طبقة-١",
      reliabilityByCritic: {
        "critic-a": { verdict: "trusted", sourceRef: "work-a", note: "note-a" },
      },
      metadata: { pfx: PREFIX, extra: [1, 2] },
    },
    // The same name, a different narrator: identity is the domain's to settle, so
    // the store must return both and never pick one.
    {
      id: NARRATOR_TWO,
      canonicalNameAr: NAME_ONE,
      nameVariants: [],
      kunya: null,
      laqab: null,
      deathYear: null,
      tabaqa: null,
      reliabilityByCritic: {},
      metadata: { pfx: PREFIX },
    },
    {
      id: NARRATOR_THREE,
      canonicalNameAr: NAME_THREE,
      nameVariants: [NAME_THREE],
      kunya: null,
      laqab: null,
      deathYear: null,
      tabaqa: null,
      reliabilityByCritic: {},
      metadata: { pfx: PREFIX },
    },
    // A narrator known by another narrator's canonical spelling as a variant.
    {
      id: NARRATOR_FOUR,
      canonicalNameAr: NAME_FOUR,
      nameVariants: [NAME_ONE],
      kunya: null,
      laqab: null,
      deathYear: null,
      tabaqa: null,
      reliabilityByCritic: {},
      metadata: { pfx: PREFIX },
    },
  ];
}

/** The seam record of a seeded chain: the insertion sequence is the double's, not the seam's. */
function seamChain({ seq: _seq, ...chain }: SeededChain) {
  return chain;
}

function chainFixture(): SeededChain[] {
  return [
    // A duplicated narrator, not in id order: the sequence is the chain.
    {
      id: chainIds[0]!,
      childId: childIds[0]!,
      collection: "bukhari",
      narratorIds: [NARRATOR_THREE, NARRATOR_ONE, NARRATOR_THREE],
      grade: "sahih",
      grader: "al-bukhari",
      sourceRef: "source:1",
      seq: 1,
    },
    // No stored verdict: no grade, no grader, no source.
    {
      id: chainIds[1]!,
      childId: childIds[0]!,
      collection: "muslim",
      narratorIds: [NARRATOR_TWO],
      grade: null,
      grader: null,
      sourceRef: null,
      seq: 2,
    },
    {
      id: chainIds[2]!,
      childId: childIds[1]!,
      collection: "bukhari",
      narratorIds: [NARRATOR_ONE],
      grade: "hasan",
      grader: "al-tirmidhi",
      sourceRef: "source:3",
      seq: 3,
    },
    {
      // An id the catalogue does not hold: the schema cannot make an array
      // element a foreign key, so the read must surface it, not lose it.
      id: chainIds[3]!,
      childId: childIds[0]!,
      collection: "bukhari",
      narratorIds: [NARRATOR_UNKNOWN],
      grade: null,
      grader: null,
      sourceRef: "source:4",
      seq: 4,
    },
  ];
}

run("narrator and chain reads (real Postgres adapter, memory equal)", () => {
  /** Run one read through both stores; the answers must be identical. */
  const both = async <A>(
    read: (store: RagStore) => Effect.Effect<A, unknown, never>,
  ): Promise<A> => {
    const fromPostgres = await Effect.runPromise(read(postgres));
    const fromMemory = await Effect.runPromise(read(memory));
    expect(fromMemory).toEqual(fromPostgres);
    return fromPostgres;
  };

  beforeAll(async () => {
    if (!URL) return;
    PREFIX = `nr-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    sql = postgresSqlRunner(postgresPool(URL));
    postgres = createPostgresRagStore(sql);
    memory = createMemoryRagStore();

    const parentId = await Effect.runPromise(
      postgres.insertDocParent({ sourceKey: PREFIX, title: PREFIX, metadata: { pfx: PREFIX } }),
    );
    childIds = await Effect.runPromise(
      postgres.insertDocChildren(
        [0, 1, 2].map((ordinal) => ({
          parentId,
          textRaw: `raw-${PREFIX}-${ordinal}`,
          textAr: `ar-${PREFIX}-${ordinal}`,
          textId: null,
          embeddingPrimary: null,
          embeddingFallback: null,
          ordinal,
          metadata: { pfx: PREFIX },
        })),
      ),
    );
    chainIds = [0, 1, 2, 3].map(() => crypto.randomUUID()).sort();

    for (const row of narratorFixture()) {
      memory.seedNarrator(row);
      await sql!`
        INSERT INTO narrators (id, canonical_name_ar, name_variants, kunya, laqab, death_year,
                               tabaqa, reliability_by_critic, metadata)
        VALUES (${row.id}, ${row.canonicalNameAr}, ${row.nameVariants}::text[], ${row.kunya},
                ${row.laqab}, ${row.deathYear}, ${row.tabaqa},
                ${JSON.stringify(row.reliabilityByCritic)}::jsonb,
                ${JSON.stringify(row.metadata)}::jsonb)
      `;
    }
    const chains = chainFixture();
    for (const chain of chains) memory.seedChain(chain);
    // One transaction for the whole fixture: every chain shares `created_at`, so
    // only the store-assigned insertion sequence can order them.
    await sql!.transaction(
      chains.map(
        (chain) => sql!`
          INSERT INTO narrator_chains (id, child_id, collection, narrator_ids, grade, grader,
                                       source_ref)
          VALUES (${chain.id}, ${chain.childId}, ${chain.collection},
                  ${[...chain.narratorIds]}::uuid[], ${chain.grade}, ${chain.grader},
                  ${chain.sourceRef})
        `,
      ),
    );
  });

  afterAll(async () => {
    if (!URL || sql === null) return;
    await sql`DELETE FROM doc_parents WHERE source_key = ${PREFIX}`;
    await sql`DELETE FROM narrators WHERE metadata->>'pfx' = ${PREFIX}`;
    await disposePostgresPools();
  });

  it("finds a narrator by canonical name or any variant, all same-name rows included", async () => {
    const rows = await both((store) => store.findNarratorsByName(NAME_ONE, { limit: 10 }));
    // Canonical matches (the same-name pair) and the variant match, in id order:
    // the store imposes an order the domain can rely on and resolves nothing.
    expect(rows.map((row) => row.id)).toEqual([NARRATOR_ONE, NARRATOR_TWO, NARRATOR_FOUR]);

    // The folded spelling is a stored variant, not the canonical name: exact
    // matching, because folding is domain logic and the store must not guess it.
    const byVariant = await both((store) =>
      store.findNarratorsByName(NAME_ONE_FOLDED, { limit: 10 }),
    );
    expect(byVariant.map((row) => row.id)).toEqual([NARRATOR_ONE]);

    expect(await both((store) => store.findNarratorsByName(NAME_ONE, { limit: 1 }))).toEqual(
      rows.slice(0, 1),
    );
    expect(await both((store) => store.findNarratorsByName(NAME_ONE, { limit: 0 }))).toEqual([]);
    expect(await both((store) => store.findNarratorsByName("", { limit: 10 }))).toEqual([]);
    expect(await both((store) => store.findNarratorsByName("no such name", { limit: 10 }))).toEqual(
      [],
    );
  });

  it("round-trips every narrator field, the critic map verbatim", async () => {
    const [row] = await both((store) => store.findNarratorsByName(NAME_ONE, { limit: 10 }));
    expect(row).toEqual(narratorFixture()[0]);
  });

  it("resolves ids in the caller's order and reports the ids the catalogue lacks", async () => {
    const lookup = await both((store) =>
      store.getNarratorsByIds([NARRATOR_TWO, NARRATOR_ONE, NARRATOR_TWO, NARRATOR_UNKNOWN]),
    );
    // Input order, deduplicated, and the unknown id is named rather than dropped —
    // the caller can tell an unresolved reference from a forgotten one.
    expect(lookup.narrators.map((row) => row.id)).toEqual([NARRATOR_TWO, NARRATOR_ONE]);
    expect(lookup.missingIds).toEqual([NARRATOR_UNKNOWN]);
    expect(await both((store) => store.getNarratorsByIds([]))).toEqual({
      narrators: [],
      missingIds: [],
    });
    expect(await both((store) => store.getNarratorsByIds([NARRATOR_UNKNOWN]))).toEqual({
      narrators: [],
      missingIds: [NARRATOR_UNKNOWN],
    });
    // A malformed id fails as a typed store error on the adapter; the double has no
    // type system to fail on, so this case is the adapter's own.
    expect((await runFail(postgres.getNarratorsByIds(["not-a-uuid"]))).kind).toBe("constraint");
  });

  it("treats every spelling of one narrator id as the same id", async () => {
    const lookup = await both((store) =>
      store.getNarratorsByIds([
        NARRATOR_ONE.toUpperCase(),
        `{${NARRATOR_ONE}}`,
        NARRATOR_ONE,
        ` {${NARRATOR_ONE.toUpperCase()}} `,
      ]),
    );
    // Case, braces, padding and duplicates are one id, resolved once.
    expect(lookup.narrators.map((row) => row.id)).toEqual([NARRATOR_ONE]);
    expect(lookup.missingIds).toEqual([]);

    // A missing id is deduplicated on its canonical form and reported in the
    // caller's first spelling; the report order follows first occurrence.
    const missing = await both((store) =>
      store.getNarratorsByIds([
        `{${NARRATOR_UNKNOWN.toUpperCase()}}`,
        NARRATOR_UNKNOWN.toUpperCase(),
        NARRATOR_UNKNOWN,
        NARRATOR_ONE.toUpperCase(),
      ]),
    );
    expect(missing.narrators.map((row) => row.id)).toEqual([NARRATOR_ONE]);
    expect(missing.missingIds).toEqual([`{${NARRATOR_UNKNOWN.toUpperCase()}}`]);
  });

  it("returns a child's chains in store-assigned insertion order, sequence verbatim", async () => {
    const chains = await both((store) => store.listChainsForChild(childIds[0]!, { limit: 10 }));
    expect(chains.map((chain) => chain.id)).toEqual([chainIds[0], chainIds[1], chainIds[3]]);
    // Order and duplicates are the chain; a sorted or deduplicated read is a false
    // report of the transmission.
    expect(chains[0]).toEqual(seamChain(chainFixture()[0]!));
    expect(chains[1]).toEqual(seamChain(chainFixture()[1]!));
    // The other child's chain is not this child's transmission evidence.
    expect(chains.map((chain) => chain.childId)).not.toContain(childIds[1]);

    expect(
      (await both((store) => store.listChainsForChild(childIds[1]!, { limit: 10 }))).map(
        (chain) => chain.id,
      ),
    ).toEqual([chainIds[2]]);
    expect(await both((store) => store.listChainsForChild(childIds[0]!, { limit: 1 }))).toEqual(
      chains.slice(0, 1),
    );
    expect(await both((store) => store.listChainsForChild(childIds[0]!, { limit: 0 }))).toEqual([]);
    expect(await both((store) => store.listChainsForChild(CHILD_MISSING, { limit: 10 }))).toEqual(
      [],
    );
  });

  it("reads three chains written in one transaction in insertion order, not id order", async () => {
    // Ids assigned in reverse insertion order: only a store-assigned sequence can
    // report the order the writer supplied.
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort().reverse();
    const childId = childIds[2]!;
    const createdAt = "2020-01-02T00:00:00Z";
    ids.forEach((id, index) => {
      memory.seedChain({
        id,
        childId,
        collection: "same-transaction",
        narratorIds: [NARRATOR_ONE],
        grade: null,
        grader: null,
        sourceRef: null,
        seq: index + 1,
      });
    });
    await sql!.transaction(
      ids.map(
        (id) => sql!`
          INSERT INTO narrator_chains (id, child_id, collection, narrator_ids, grade, grader,
                                       source_ref, created_at)
          VALUES (${id}, ${childId}, 'same-transaction', ${[NARRATOR_ONE]}::uuid[], NULL, NULL,
                  NULL, ${createdAt}::timestamptz)
        `,
      ),
    );
    const timestamps = await sql!`
      SELECT count(DISTINCT created_at)::int AS n
      FROM narrator_chains
      WHERE child_id = ${childId}
    `;
    // One timestamp for the batch: `created_at` cannot order these rows.
    expect(timestamps).toEqual([{ n: 1 }]);
    const chains = await both((store) => store.listChainsForChild(childId, { limit: 10 }));
    expect(chains.map((chain) => chain.id)).toEqual(ids);
  });

  it("pages a collection by the id cursor without skipping or repeating a row", async () => {
    const first = await both((store) => store.listChainsByCollection("bukhari", { limit: 2 }));
    expect(first.rows.map((chain) => chain.id)).toEqual([chainIds[0], chainIds[2]]);
    expect(first.nextAfterId).toBe(chainIds[2]);

    const second = await both((store) =>
      store.listChainsByCollection("bukhari", { limit: 2, afterId: first.nextAfterId! }),
    );
    expect(second.rows.map((chain) => chain.id)).toEqual([chainIds[3]]);
    // A short page is the end of the set: no cursor to follow.
    expect(second.nextAfterId).toBeNull();

    // The boundary is exclusive, and the other collection's chain never bleeds in.
    expect(
      (
        await both((store) =>
          store.listChainsByCollection("bukhari", { limit: 5, afterId: chainIds[2]! }),
        )
      ).rows.map((chain) => chain.id),
    ).toEqual([chainIds[3]]);
    expect(
      (await both((store) => store.listChainsByCollection("muslim", { limit: 5 }))).rows.map(
        (chain) => chain.id,
      ),
    ).toEqual([chainIds[1]]);
    expect(await both((store) => store.listChainsByCollection("bukhari", { limit: 0 }))).toEqual({
      rows: [],
      nextAfterId: null,
    });
    expect(
      await both((store) => store.listChainsByCollection("collection-missing", { limit: 5 })),
    ).toEqual({ rows: [], nextAfterId: null });
  });
});
