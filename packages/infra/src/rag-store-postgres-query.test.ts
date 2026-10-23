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
