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

/**
 * The `--only-missing` guard (ADR-0037's recorded revisit trigger, folded in
 * from #141 for issue #213): narrow the requested collections to those whose
 * landed child count (read from the store through the
 * `countDocChildrenByMetadata` seam, keyed on the chunk metadata field that
 * carries the collection label) is zero, so a naive range loop cannot
 * re-pay embeddings for collections already landed. Idempotent upserts
 * dedupe *rows*, not *spend* — a pass re-embeds every row it reads.
 *
 * The counts come from the caller (the CLI reads them before any
 * acquisition, through the store seam). `landedCounts` maps the same
 * metadata value the CLI filters on — the collection name — to its landed
 * child count; a collection absent from the map reads as zero. Returns
 * `{ collections, skipped }` — the kept selection plus, for the run log,
 * the already-landed collections that were dropped — or `{ error }` when
 * nothing is missing (the guard refuses a no-op paid pass rather than
 * running one).
 */
export function onlyMissingCollections(collections, landedCounts) {
  const missing = collections.filter((c) => (landedCounts[c] ?? 0) === 0);
  if (missing.length === 0) {
    return {
      error:
        `--only-missing: every selected collection already has children landed ` +
        `(${collections.map((c) => `${c}=${landedCounts[c] ?? 0}`).join(", ")}) — ` +
        `nothing to ingest; refusing a no-op paid pass`,
    };
  }
  const landed = collections.filter((c) => (landedCounts[c] ?? 0) > 0);
  return { collections: missing, landed };
}
