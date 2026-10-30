import {
  filterMatchOf,
  isRelationFilter,
  type MetadataFilterValue,
  type RetrievalTrack,
} from "./rag-store";

/**
 * Postgres-specific similarity-search SQL builder.
 *
 * This is pure (no I/O) but Postgres-specific, so it lives beside the
 * adapter rather than in the DB-free `rag-store-shared.ts`. Keeping it in its
 * own module means the executable SQL stays in the Postgres adapter surface
 * (satisfying "all SQL in the adapter package") while remaining unit-testable
 * and coverage-gated without a live database.
 *
 * Invariant: no column identifier is ever built from input. The only runtime
 * choice is which of two fixed columns (a hard allowlist) the query targets;
 * filter keys and values are bound parameters ($N).
 */

/**
 * Track role → physical embedding column. The two-column allowlist is the
 * whole point of ADR-0013's dual-track schema; `primary`/`fallback` are
 * engine-level role names — KajianQ binds them to its AR/ID language tracks
 * at the domain-pack boundary, so no language code appears here.
 */
const SIMILARITY_COLUMNS: Record<RetrievalTrack, string> = {
  primary: "embedding_primary",
  fallback: "embedding_fallback",
};

/**
 * How one metadata filter binds. `exact` is two parameter slots (key, values);
 * `derived` adds the absent-key alternative's two, so its clause is
 * `(key = ANY(values) OR (key IS NULL AND absentKey = ANY(absentValues)))`.
 */
export type FilterClause = "exact" | "derived" | "chain_grade" | "chain_narrator";

/**
 * Read a filter record into the clauses {@link buildSimilarityQuery} emits and
 * the values the adapter binds, in one pass: the slot arithmetic and the bound
 * parameters are produced from one reading of the record, so the SQL and the
 * values cannot disagree about how many slots a clause carries.
 *
 * Values stay bound in the caller's order. A `whenAbsent` alternative appends
 * its own key and value set after its dimension's — never before, which is the
 * slot order the builder assigns.
 *
 * A **relation clause** binds only its value set: the relation and its column are
 * fixed by the builder's allowlist, so the key a caller wrote is not a parameter
 * and can never become an identifier. It is refused when it also carries a
 * `whenAbsent` alternative — the derived case is a metadata-key rule the relation
 * clause has no column for, and silently dropping it would widen the filter.
 */
export function filterBindings(filters: Record<string, MetadataFilterValue>): {
  clauses: FilterClause[];
  values: unknown[];
} {
  const clauses: FilterClause[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (isRelationFilter(value)) {
      if ("whenAbsent" in value) {
        throw new TypeError("a relation filter carries no absent-key alternative");
      }
      clauses.push(value.on === "grade" ? "chain_grade" : "chain_narrator");
      values.push([...value.values]);
      continue;
    }
    const match = filterMatchOf(value);
    values.push(key, match.values);
    if (match.whenAbsent === undefined) {
      clauses.push("exact");
      continue;
    }
    clauses.push("derived");
    values.push(match.whenAbsent.key, match.whenAbsent.values);
  }
  return { clauses, values };
}

/**
 * Build the similarity-search SQL string for a track with the given filter
 * clauses. Parameter slots: $1 = embedding, $2 = limit, then each clause's
 * slots from a running counter (so the arithmetic stays local and auditable
 * rather than magic offsets).
 */
export function buildSimilarityQuery(
  track: RetrievalTrack,
  clauses: readonly FilterClause[],
): string {
  const column = SIMILARITY_COLUMNS[track];
  // The embedding columns are deliberately NOT selected: the search already
  // used the vectors to order the rows, and the retriever reads only
  // id/text/metadata, so shipping them is pure overhead. The hit's
  // `embeddingPrimary`/`embeddingFallback` are therefore `null` by contract.
  const select = `
  SELECT id, parent_id, text_raw, text_ar, text_id, citation,
         NULL::text AS embedding_primary,
         NULL::text AS embedding_fallback,
         ordinal, metadata, created_at,
         (${column} <=> $1::vector) AS distance,
         ROW_NUMBER() OVER (ORDER BY ${column} <=> $1::vector) AS rank_dense
  FROM doc_children
  WHERE ${column} IS NOT NULL`;
  if (clauses.length === 0) {
    return `${select}\n  ORDER BY ${column} <=> $1::vector\n  LIMIT $2\n`;
  }
  // $1 embedding, $2 limit → filters start at $3, two slots per clause and two
  // more for a clause's absent-key alternative.
  let slot = 3;
  const where: string[] = [];
  for (const clause of clauses) {
    if (clause === "chain_grade" || clause === "chain_narrator") {
      // The relation clause binds ONE value set and no key: the relation table and
      // the column are the allowlist's, so nothing a caller wrote is an identifier.
      // A child matches when ANY of its rows carries one of the values — the
      // filter selects the child, never a subset of its rows.
      const vIdx = slot++;
      where.push(
        clause === "chain_grade"
          ? `EXISTS (SELECT 1 FROM narrator_chains WHERE narrator_chains.child_id = doc_children.id AND narrator_chains.grade = ANY($${vIdx}::text[]))`
          : `EXISTS (SELECT 1 FROM narrator_chains WHERE narrator_chains.child_id = doc_children.id AND narrator_chains.narrator_ids && $${vIdx}::uuid[])`,
      );
      continue;
    }
    const kIdx = slot++;
    const vIdx = slot++;
    if (clause === "exact") {
      where.push(`metadata->>$${kIdx} = ANY($${vIdx}::text[])`);
      continue;
    }
    const aIdx = slot++;
    const aVIdx = slot++;
    where.push(
      `(metadata->>$${kIdx} = ANY($${vIdx}::text[]) OR (metadata->>$${kIdx} IS NULL AND metadata->>$${aIdx} = ANY($${aVIdx}::text[])))`,
    );
  }
  return `${select}\n        AND ${where.join("\n        AND ")}\n  ORDER BY ${column} <=> $1::vector\n  LIMIT $2\n`;
}
