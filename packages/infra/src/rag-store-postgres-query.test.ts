import { describe, expect, it } from "vite-plus/test";
import { buildSimilarityQuery, filterBindings } from "./rag-store-postgres-query";

/**
 * Pure unit tests for the Postgres similarity-search SQL builder. These run in
 * every environment (no database needed); the adapter's I/O is exercised by
 * the secret-gated contract suite in rag-store-postgres.test.ts.
 */
describe("rag-store-postgres-query: buildSimilarityQuery", () => {
  it("targets the primary track and never names the fallback track (and vice versa)", () => {
    const primary = buildSimilarityQuery("primary", []);
    const fallback = buildSimilarityQuery("fallback", []);
    expect(primary).toContain("embedding_primary <=> $1::vector");
    expect(primary).not.toContain("embedding_fallback <=> $1::vector");
    expect(fallback).toContain("embedding_fallback <=> $1::vector");
    expect(fallback).not.toContain("embedding_primary <=> $1::vector");
  });

  it("emits one key slot + one array slot per exact filter, assigned from $3 upward", () => {
    const q = buildSimilarityQuery("primary", ["exact", "exact"]);
    // $1 embedding, $2 limit → first filter is ($3,$4), second ($5,$6).
    expect(q).toContain("metadata->>$3 = ANY($4::text[])");
    expect(q).toContain("metadata->>$5 = ANY($6::text[])");
  });

  it("scales slot indices with the clause list", () => {
    const q = buildSimilarityQuery("primary", ["exact", "exact", "exact"]);
    expect(q).toContain("metadata->>$7 = ANY($8::text[])");
  });

  it("omits the AND block entirely when there are no filters", () => {
    expect(buildSimilarityQuery("primary", [])).not.toContain("AND metadata");
    expect(buildSimilarityQuery("primary", [])).toContain("LIMIT $2");
  });

  it("never interpolates filter key text — keys are bound parameters, not string-built", () => {
    const q = buildSimilarityQuery("primary", ["exact", "exact"]);
    // A real filter key would only ever appear as a bound $N value, not in SQL.
    expect(q).not.toContain("pfx");
    expect(q).not.toContain("metadata->>'pfx'");
  });

  it("does not ship the embedding vectors back (the Worker payload defect)", () => {
    // Regression, live smoke gs-v0-002: selecting the vectors cost ~390 KB of
    // float text per 10-hit search; a chat request ran 8 searches and parsed
    // ~245k floats, and Cloudflare killed it as `exceededResources`. A hit's
    // embeddings are null by contract — nothing reads them.
    for (const track of ["primary", "fallback"] as const) {
      const q = buildSimilarityQuery(track, []);
      expect(q).toContain("NULL::text AS embedding_primary");
      expect(q).toContain("NULL::text AS embedding_fallback");
      expect(q).not.toMatch(/embedding_(primary|fallback)::text/);
    }
  });
});

/**
 * The derived case, composed with exact ones. The clause is an OR of "the value
 * is stored" and "no value at all, and the second key is one of these" — the
 * shape a domain pack needs to express a read-time derivation without the
 * engine learning what any key or value means.
 */
describe("rag-store-postgres-query: a filter's derived case", () => {
  it("ORs the absent-key alternative into the same clause, then keeps ANDing the rest", () => {
    const q = buildSimilarityQuery("primary", ["exact", "derived"]);
    expect(q).toContain("metadata->>$3 = ANY($4::text[])");
    // The alternative sits INSIDE its dimension's clause, and the clause closes
    // before the next one starts: a top-level AND of the alternative would drop
    // every stored value that is not also derived.
    expect(q).toContain(
      "AND (metadata->>$5 = ANY($6::text[]) OR (metadata->>$5 IS NULL AND metadata->>$7 = ANY($8::text[])))",
    );
    expect(q).toContain("ORDER BY embedding_primary <=> $1::vector");
  });

  it("binds four values for a derived clause and two for an exact one, in slot order", () => {
    const { clauses, values } = filterBindings({
      alpha: ["a"],
      beta: {
        values: ["x"],
        whenAbsent: { key: "gamma", values: ["m", "n"] },
      },
    });
    expect(clauses).toEqual(["exact", "derived"]);
    expect(values).toEqual(["alpha", ["a"], "beta", ["x"], "gamma", ["m", "n"]]);
    // The builder's slots and the bound values are one reading of the record: a
    // derived clause's last slot is the alternative's value array.
    const q = buildSimilarityQuery("primary", clauses);
    expect(q).toContain("metadata->>$7 = ANY($8::text[])");
  });

  it("keeps a plain value set on the exact path, whether it arrives as a string, a list or a match", () => {
    const single = filterBindings({ k: "v" });
    const list = filterBindings({ k: ["v"] });
    const match = filterBindings({ k: { values: ["v"] } });
    expect(single).toEqual(list);
    expect(list).toEqual(match);
    expect(single.clauses).toEqual(["exact"]);
    expect(single.values).toEqual(["k", ["v"]]);
  });
});

/**
 * The relation clause: a filter over the transmission rows attached to a child.
 * Its column is the builder's allowlist, so the clause carries no caller-written
 * identifier, and its match selects the child as a whole — the `EXISTS` yields
 * one row per matching child, never one row per matching chain.
 */
describe("rag-store-postgres-query: a filter's relation clause", () => {
  it("binds one value set per relation clause and no key parameter", () => {
    const grade = filterBindings({
      chainGrade: { relation: "chains", on: "grade", values: ["sahih"] },
    });
    expect(grade.clauses).toEqual(["chain_grade"]);
    // No key is bound: the relation and the column are the allowlist's, not the
    // caller's, so a value set is the whole parameter list.
    expect(grade.values).toEqual([["sahih"]]);

    const narrator = filterBindings({
      narratorId: { relation: "chains", on: "narratorIds", values: ["n-1", "n-2"] },
    });
    expect(narrator.clauses).toEqual(["chain_narrator"]);
    expect(narrator.values).toEqual([["n-1", "n-2"]]);
  });

  it("emits a fixed EXISTS clause per column, comparing the child and never a chain row", () => {
    const grade = buildSimilarityQuery("primary", ["chain_grade"]);
    expect(grade).toContain(
      "EXISTS (SELECT 1 FROM narrator_chains WHERE narrator_chains.child_id = doc_children.id AND narrator_chains.grade = ANY($3::text[]))",
    );
    const narrator = buildSimilarityQuery("primary", ["chain_narrator"]);
    expect(narrator).toContain(
      "EXISTS (SELECT 1 FROM narrator_chains WHERE narrator_chains.child_id = doc_children.id AND narrator_chains.narrator_ids && $3::uuid[])",
    );
  });

  it("keeps the slot arithmetic aligned when a relation clause follows a metadata one", () => {
    const { clauses, values } = filterBindings({
      sourceType: ["hadith"],
      chainGrade: { relation: "chains", on: "grade", values: ["dhaif"] },
    });
    expect(clauses).toEqual(["exact", "chain_grade"]);
    expect(values).toEqual(["sourceType", ["hadith"], ["dhaif"]]);
    const q = buildSimilarityQuery("primary", clauses);
    expect(q).toContain("metadata->>$3 = ANY($4::text[])");
    // $3/$4 are the metadata clause's two slots; the relation clause binds ONE,
    // at $5 — the count the builder emits and the values it binds come from one
    // reading of the record.
    expect(q).toContain("narrator_chains.grade = ANY($5::text[])");
  });

  it("refuses a relation clause that carries a metadata-only alternative", () => {
    expect(() =>
      filterBindings({
        chainGrade: {
          relation: "chains",
          on: "grade",
          values: ["sahih"],
          whenAbsent: { key: "collection", values: ["bukhari"] },
        } as never,
      }),
    ).toThrow(TypeError);
  });
});
