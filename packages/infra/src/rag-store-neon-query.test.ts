import { describe, expect, it } from "vitest";
import { buildSimilarityQuery } from "./rag-store-neon-query";

/**
 * Pure unit tests for the Neon similarity-search SQL builder. These run in
 * every environment (no database needed); the adapter's I/O is exercised by
 * the secret-gated contract suite in rag-store-neon.test.ts.
 */
describe("rag-store-neon-query: buildSimilarityQuery", () => {
  it("targets the primary track and never names the fallback track (and vice versa)", () => {
    const primary = buildSimilarityQuery("primary", 0);
    const fallback = buildSimilarityQuery("fallback", 0);
    expect(primary).toContain("embedding_primary <=> $1::vector");
    expect(primary).not.toContain("embedding_fallback <=> $1::vector");
    expect(fallback).toContain("embedding_fallback <=> $1::vector");
    expect(fallback).not.toContain("embedding_primary <=> $1::vector");
  });

  it("emits one key slot + one array slot per filter, assigned from $3 upward", () => {
    const q = buildSimilarityQuery("primary", 2);
    // $1 embedding, $2 limit → first filter is ($3,$4), second ($5,$6).
    expect(q).toContain("metadata->>$3 = ANY($4::text[])");
    expect(q).toContain("metadata->>$5 = ANY($6::text[])");
  });

  it("scales slot indices with filter count", () => {
    const q = buildSimilarityQuery("primary", 3);
    expect(q).toContain("metadata->>$7 = ANY($8::text[])");
  });

  it("omits the AND block entirely when there are no filters", () => {
    expect(buildSimilarityQuery("primary", 0)).not.toContain("AND metadata");
    expect(buildSimilarityQuery("primary", 0)).toContain("LIMIT $2");
  });

  it("never interpolates filter key text — keys are bound parameters, not string-built", () => {
    const q = buildSimilarityQuery("primary", 2);
    // A real filter key would only ever appear as a bound $N value, not in SQL.
    expect(q).not.toContain("pfx");
    expect(q).not.toContain("metadata->>'pfx'");
  });
});