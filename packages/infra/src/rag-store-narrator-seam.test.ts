import { describe, expect, it } from "vite-plus/test";
import { canonicalNarratorId } from "./rag-store-narrator-seam";

/**
 * The id canonicaliser's spelling contract, pinned without a database.
 *
 * The function exists so a read maps rows and caller ids under one form; it is
 * not a uuid repair step. The cases below split those two duties: the spellings
 * Postgres accepts for one uuid canonicalise, and every malformed brace shape
 * passes through untouched so the query — not this function — rejects it.
 */

const UUID = "abcdabcd-1234-4234-8234-abcdabcdabcd";

describe("canonicalNarratorId", () => {
  it("canonicalises the accepted spellings of one uuid", () => {
    // Case, one brace pair and surrounding padding are spelling, not identity.
    expect(canonicalNarratorId(UUID.toUpperCase())).toBe(UUID);
    expect(canonicalNarratorId(`{${UUID}}`)).toBe(UUID);
    expect(canonicalNarratorId(` {${UUID.toUpperCase()}} `)).toBe(UUID);
    expect(canonicalNarratorId(`  ${UUID}  `)).toBe(UUID);
    // Padding inside the brace pair is the same spelling.
    expect(canonicalNarratorId(`{ ${UUID} }`)).toBe(UUID);
  });

  it("passes every malformed brace shape through for the query to reject", () => {
    // Each is one brace operation away from the valid uuid. Stripping a leading
    // and a trailing brace independently would turn the first two into `UUID`,
    // reduce `{{UUID}}` to a braced uuid Postgres accepts, and blank `{}` into
    // the silently ignored empty id; the canonical form must stay the input so
    // the adapter's `constraint` contract holds.
    for (const malformed of [`{${UUID}`, `${UUID}}`, `{{${UUID}}}`, "{}"]) {
      expect(canonicalNarratorId(malformed)).toBe(malformed);
    }
    // A whitespace-only brace interior is not a uuid either, so it is not
    // stripped down to the ignored blank id.
    expect(canonicalNarratorId("{ }")).toBe("{ }");
  });
});
