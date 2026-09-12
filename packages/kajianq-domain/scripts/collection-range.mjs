/**
 * collection-range.mjs — the `--offset`/`--limit` slice for the corpus ingest
 * CLIs. Extracted from `ingest-hadith.mjs` so the range rules are testable
 * (`tests/scripts/ingest-hadith-range.test.mjs`) and so a quota-bound ingest
 * can be split into resumable passes.
 *
 * Why an offset exists at all: the ingestion runner embeds *and writes* a
 * whole run's children together, so one long pass over every collection is
 * all-or-nothing — a job timeout or a rate-limit wall costs the entire run,
 * and a repair pass has no way to address a subset. `--offset N --limit 1`
 * ingests one collection per invocation, each pass committing its children
 * before the next starts; re-running any pass is a safe upsert (ADR
 * idempotency: parents by sourceKey, children by (parentId, ordinal)).
 */

/**
 * Read `--offset` (default 0) and `--limit` (default null = to the end) from
 * an argv slice. A flag whose value is not an integer reads as `NaN` so the
 * caller can fail loudly instead of silently ingesting the wrong range
 * (`slice(0, NaN)` used to yield an empty run that reported success).
 */
export function parseCollectionRange(args) {
  const readInt = (flag) => {
    const idx = args.indexOf(flag);
    if (idx < 0) return null;
    return Number(args[idx + 1]);
  };
  return { offset: readInt("--offset") ?? 0, limit: readInt("--limit") };
}

/**
 * Resolve a range against the collection list. Returns `{ collections }` or
 * `{ error }` — never a partially-valid selection.
 */
export function selectCollections(collections, { offset, limit }) {
  if (!Number.isInteger(offset) || offset < 0) {
    return { error: `--offset must be an integer >= 0, got "${offset}"` };
  }
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    return { error: `--limit must be an integer >= 1, got "${limit}"` };
  }
  if (offset >= collections.length) {
    return {
      error: `--offset ${offset} is past the last collection (index ${collections.length - 1})`,
    };
  }
  return {
    collections: collections.slice(offset, limit === null ? undefined : offset + limit),
  };
}
