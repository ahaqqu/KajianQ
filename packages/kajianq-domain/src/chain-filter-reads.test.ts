// @requires-postgres
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import {
  createPostgresRagStore,
  disposePostgresPools,
  postgresPool,
  postgresSqlRunner,
  type RagStore,
  type StoreError,
} from "@app/infra";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";
import { relationOf, storeKeyOf } from "./filters";
import { storeFilters } from "./chat-filter-policy";
import { readChainEvidence } from "./chat-isnad";
import { renderEvidenceChunk } from "./chat-assembler";

/**
 * Chain/narrator **retrieval filters** on real Postgres, held to the in-memory
 * double.
 *
 * The property: a filter over the transmission rows attached to a child selects
 * the child, and only when a row of that child actually matches — never by
 * rewriting the child, and never by narrowing what the child then reports.
 *
 * The neutrality half is the reason this suite exists beside the unit cases: a
 * child carrying a `sahih` and a `dhaif` chain matches a `chainGrade: sahih`
 * filter as a whole, and `listChainsForChild` afterwards must still return BOTH
 * rows. A store that filtered the rows themselves would hand the citation layer a
 * half-transmission and the answer would present one grade as the truth.
 *
 * The gated half is skipped without `DATABASE_URL` (the `@requires-postgres`
 * marker), so the DB-less gate keeps running; the same fixture is seeded into
 * both stores and every read is compared before it is asserted.
 */

const URL = process.env.DATABASE_URL;
const run = URL ? describe : describe.skip;

const NARRATOR_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NARRATOR_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let PREFIX: string;
let sql: ReturnType<typeof postgresSqlRunner> | null = null;
let postgres: RagStore;
let memory: ReturnType<typeof createMemoryRagStore>;
let matchedChildId: string;
let plainChildId: string;
let memoryMatchedId: string;

/** A unit-ish vector of the corpus's dimension, distinct per child. */
function vec(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, index) => (index === seed ? 1 : 0));
}

/** Read the chain filter record the retriever hands the store. */
function chainFilters(dimension: "chainGrade" | "narratorId", values: string[]) {
  return storeFilters({ [storeKeyOf(dimension)]: values });
}

run("chain-grade and narrator retrieval filters (real Postgres, memory equal)", () => {
  beforeAll(async () => {
    if (!URL) return;
    PREFIX = `cf-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    sql = postgresSqlRunner(postgresPool(URL));
    postgres = createPostgresRagStore(sql);
    memory = createMemoryRagStore();

    const parentId = await Effect.runPromise(
      postgres.insertDocParent({ sourceKey: PREFIX, title: PREFIX, metadata: { pfx: PREFIX } }),
    );
    const childMetadata = { pfx: PREFIX, sourceType: "hadith", grade: "sahih" };
    const [matched, plain] = await Effect.runPromise(
      postgres.insertDocChildren([
        {
          parentId,
          textRaw: `raw-${PREFIX}-0`,
          textAr: `ar-${PREFIX}-0`,
          textId: null,
          embeddingPrimary: vec(0),
          embeddingFallback: null,
          ordinal: 0,
          metadata: childMetadata,
        },
        {
          parentId,
          textRaw: `raw-${PREFIX}-1`,
          textAr: `ar-${PREFIX}-1`,
          textId: null,
          embeddingPrimary: vec(1),
          embeddingFallback: null,
          ordinal: 1,
          metadata: { pfx: PREFIX, sourceType: "hadith" },
        },
      ]),
    );
    if (matched === undefined || plain === undefined) throw new Error("fixture children missing");
    matchedChildId = matched;
    plainChildId = plain;

    // One child, two chains with conflicting grades: the case the whole ticket is
    // about. The plain child carries one hasan chain, so a grade filter must tell
    // them apart.
    const chainRows = [
      {
        childId: matchedChildId,
        narratorIds: [NARRATOR_A, NARRATOR_B],
        grade: "sahih",
        grader: "al-bukhari",
      },
      {
        childId: matchedChildId,
        narratorIds: [NARRATOR_A],
        grade: "dhaif",
        grader: "al-daraqutni",
      },
      { childId: plainChildId, narratorIds: [NARRATOR_B], grade: "hasan", grader: "al-tirmidhi" },
    ];
    for (const row of chainRows) {
      await sql.query(
        `INSERT INTO narrator_chains (child_id, collection, narrator_ids, grade, grader)
         VALUES ($1, $2, $3::uuid[], $4, $5)`,
        [row.childId, "fixture", row.narratorIds, row.grade, row.grader],
      );
    }

    // The same fixture in the in-memory double: two children and the same chains.
    const memoryParentId = memory.insertDocParent({
      sourceKey: PREFIX,
      title: PREFIX,
      metadata: { pfx: PREFIX },
    });
    void memoryParentId;
    const memoryChildren = memory.insertDocChildren([
      {
        parentId: await Effect.runPromise(memoryParentId),
        textRaw: `raw-${PREFIX}-0`,
        textAr: `ar-${PREFIX}-0`,
        textId: null,
        embeddingPrimary: vec(0),
        embeddingFallback: null,
        ordinal: 0,
        metadata: childMetadata,
      },
      {
        parentId: await Effect.runPromise(memoryParentId),
        textRaw: `raw-${PREFIX}-1`,
        textAr: `ar-${PREFIX}-1`,
        textId: null,
        embeddingPrimary: vec(1),
        embeddingFallback: null,
        ordinal: 1,
        metadata: { pfx: PREFIX, sourceType: "hadith" },
      },
    ]);
    const [memoryMatched, memoryPlain] = await Effect.runPromise(memoryChildren);
    if (memoryMatched === undefined) throw new Error("memory fixture child missing");
    memoryMatchedId = memoryMatched;
    for (const [index, row] of chainRows.entries()) {
      const childId = row.childId === matchedChildId ? memoryMatched : memoryPlain;
      if (childId === undefined) throw new Error("memory fixture child missing");
      memory.seedChain({
        id: crypto.randomUUID(),
        childId,
        collection: "fixture",
        narratorIds: row.narratorIds,
        grade: row.grade,
        grader: row.grader,
        sourceRef: null,
        seq: index + 1,
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (sql !== null) await disposePostgresPools();
  }, 30_000);

  /**
   * Both stores answer a search identically, compared by FIXTURE LABEL rather than
   * by raw id: the double mints its own row ids, so the shared property is which
   * fixture child a filter selected, in which order.
   */
  const labels = (childId: string): string =>
    childId === matchedChildId || childId === memoryMatchedId ? "matched" : "plain";
  const both = async (filters: Record<string, unknown>): Promise<readonly string[]> => {
    const search = (store: RagStore) =>
      Effect.runPromise(
        store.similaritySearch("primary", vec(0), {
          limit: 10,
          filters: { pfx: PREFIX, ...filters } as never,
        }),
      );
    const fromPostgres = await search(postgres);
    const fromMemory = await search(memory);
    const postgresLabels = fromPostgres.map((hit) => labels(hit.child.id));
    expect(fromMemory.map((hit) => labels(hit.child.id))).toEqual(postgresLabels);
    return postgresLabels;
  };

  it("selects a child by a per-chain grade, including a grade one of its chains carries", async () => {
    const hits = await both(chainFilters("chainGrade", ["dhaif"]));
    expect(hits).toEqual(["matched"]);
    expect(relationOf(storeKeyOf("chainGrade"))).toBe("grade");
  });

  it("selects a child by a narrator id its chain ordered sequence contains", async () => {
    // Both children carry NARRATOR_B somewhere in their chain; NARRATOR_A is the
    // one that distinguishes them, as a non-leading member of the matched child's
    // sequence — the overlap is over the whole array, not the first element.
    const hits = await both(chainFilters("narratorId", [NARRATOR_A]));
    expect(hits).toEqual(["matched"]);
    expect(relationOf(storeKeyOf("narratorId"))).toBe("narratorIds");
  });

  it("matches a child by either grade while still reporting every chain it holds", async () => {
    // The neutrality invariant at the store layer: a filter may SELECT a child,
    // it may never rewrite the rows a child reports. The sahih filter returns the
    // child whose weaker chain is also true, and the read below shows both rows
    // are still there for the citation layer to present neutrally.
    const hits = await both(chainFilters("chainGrade", ["sahih"]));
    expect(hits).toEqual(["matched"]);
    for (const [store, childId] of [
      [postgres, matchedChildId],
      [memory, memoryMatchedId],
    ] as const) {
      const chains = await Effect.runPromise(store.listChainsForChild(childId, { limit: 10 }));
      expect(chains.map((chain) => chain.grade).sort()).toEqual(["dhaif", "sahih"]);
    }
    // And the plain child, whose only chain is hasan, is NOT selected by a sahih
    // filter: a filter that matched every child would be no filter at all.
    expect(hits).not.toContain("plain");
  });

  it("returns every child when the dimension is absent, and none when the grade is unrepresented", async () => {
    expect([...(await both({}))].sort()).toEqual(["matched", "plain"]);
    expect(await both(chainFilters("chainGrade", ["mutawatir"]))).toEqual([]);
  });

  /**
   * The same fixture read as **chain evidence**: the per-passage read the citation
   * sheet and the generator consume, over the real store and the double.
   *
   * The property: the rows a filter selected a passage by are not the rows the
   * citation renders — the passage arrives whole, in store order, with its own
   * grades. A store that let the filter shape the read would hand the reader the
   * matched row alone.
   */
  const readEvidence = async (store: RagStore) => {
    const { chunks } = await Effect.runPromise(
      readChainEvidence({
        chunks: [
          {
            id: store === memory ? memoryMatchedId : matchedChildId,
            text: "raw",
            metadata: { pfx: PREFIX, sourceType: "hadith", citation: "HR. Fixture no. 1" },
          } as never,
        ],
        store: store as never,
        bridge: <A>(effect: Effect.Effect<A, StoreError>) => Effect.runPromise(effect),
      }),
    );
    const rendered = renderEvidenceChunk(chunks[0] as never);
    // The double mints its own narrator ids; compare the parts the fixture shares.
    return rendered.replaceAll(NARRATOR_A, "A").replaceAll(NARRATOR_B, "B");
  };

  it("renders both stored chains with their own grades, in store order", async () => {
    const fromPostgres = await readEvidence(postgres);
    const fromMemory = await readEvidence(memory);
    expect(fromMemory).toBe(fromPostgres);
    expect(fromPostgres).toContain("(Sahih — al-bukhari");
    expect(fromPostgres).toContain("(Dhaif — al-daraqutni");
    // Insertion order: the weak chain is second, never demoted or dropped.
    expect(fromPostgres.indexOf("Sahih — al-bukhari")).toBeLessThan(
      fromPostgres.indexOf("Dhaif — al-daraqutni"),
    );
  }, 60_000);
});
