#!/usr/bin/env bun
/**
 * ingest-hadith.mjs — the `ingest:hadith` Bun CLI.
 *
 *   bun run ingest:hadith                          # full ingest (needs DATABASE_URL + API keys)
 *   bun run ingest:hadith -- --check               # integrity check only (no LLM/embedding spend)
 *   bun run ingest:hadith -- --limit 2             # ingest only the first N collections
 *   bun run ingest:hadith -- --offset 3 --limit 1  # one collection per pass (resumable)
 *   bun run ingest:hadith -- --only-missing        # ingest only collections with zero landed children
 *
 * Source: fawazahmed0/hadith-api editions (Unlicense). The archived raw bytes are the single source
 * of truth: the domain SourceParser re-parses and integrity-checks them inside the runner.
 * Idempotency: parents upsert by sourceKey, children by (parentId, ordinal), pairs by pairKey,
 * reports by run id — re-running is safe by construction (rows), but NOT by cost (a pass re-embeds
 * every row it reads, ADR-0037). `--only-missing` reads the landed per-collection counts through the
 * store seam before any acquisition and drops already-landed collections, so a range loop cannot
 * re-pay for them.
 */
import * as app from "@app/infra";
import * as ingest from "@app/rag-ingest";
import * as domain from "@app/kajianq-domain";
import {
  acquireFiles,
  archiveRawSources,
  createArchiveObjectStore,
  onlyMissingCollections,
  parseCollectionRange,
  resolveFromCwd,
  selectCollections,
} from "./archive-store.mjs";

const resolve = resolveFromCwd;

// Config: read once at the composition root; provider roles and credentials are resolved through
// the config seam, so no vendor names live here.
const EDITIONS_BASE =
  process.env.HADITH_EDITIONS_BASE_URL ??
  "https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions";
const R2_PREFIX = "hadith/fawazahmed0-hadith-api";

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
// Read the store's per-collection child counts first and ingest only the missing ones. The chunk
// metadata field carrying the collection label is written by this domain pack's parser, so the key
// lives here — the seam stays engine-generic.
const ONLY_MISSING = args.includes("--only-missing");
const COLLECTION_METADATA_KEY = "collection";
// Range parsing and its validation live in collection-range.mjs so they are unit-tested: a bad flag
// must fail loudly, never silently ingest nothing (`slice(0, NaN)`) or the wrong slice.
const RANGE = parseCollectionRange(args);

const logger = app.createLogger({ script: "ingest:hadith" });

function fail(msg) {
  logger.error(msg);
  process.exit(1);
}

// Argument validation comes before environment validation: a bad flag must report itself even when
// the environment is also incomplete.
const selection = selectCollections(domain.HADITH_COLLECTIONS, RANGE);
if (selection.error !== undefined) fail(selection.error);
const collections = selection.collections;

// Main.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl && !CHECK_ONLY) fail("DATABASE_URL is not set");

logger.info("starting", {
  mode: CHECK_ONLY ? "integrity-check" : "full-ingestion",
  collections,
  onlyMissing: ONLY_MISSING,
});

// --only-missing narrows the selection by measured store state BEFORE any acquisition: a store read
// before the spend, never inside the embedding loop.
let selected = collections;
if (ONLY_MISSING && !CHECK_ONLY) {
  const store = app.resolvePostgresStore(databaseUrl, { logger });
  const landedCounts = {};
  for (const { value, count } of await ingest.runStoreEffect(
    store.countDocChildrenByMetadata(COLLECTION_METADATA_KEY),
  )) {
    if (value !== null) landedCounts[value] = count;
  }
  logger.info("landed counts read", { landedCounts });
  const narrowed = onlyMissingCollections(collections, landedCounts);
  if (narrowed.error !== undefined) fail(narrowed.error);
  if (narrowed.landed.length > 0) {
    logger.info("skipping already-landed collections", { landed: narrowed.landed });
  }
  selected = narrowed.collections;
  if (selected.length !== collections.length) {
    logger.info("selection narrowed by --only-missing", { selected });
  }
} else {
  selected = collections;
}

const cacheDir = process.env.HADITH_SOURCE_DIR;
const entries = selected.flatMap((c) => [
  { url: `${EDITIONS_BASE}/ara-${c}.json`, cacheFile: `ara-${c}.json` },
  { url: `${EDITIONS_BASE}/ind-${c}.json`, cacheFile: `ind-${c}.json` },
]);
const texts = await acquireFiles(entries, { log: logger, cacheDir });

const editions = selected.map((c, i) => ({
  collection: c,
  arabicText: texts[i * 2],
  indonesianText: texts[i * 2 + 1],
}));

// Integrity checks run in every mode, before any spend; unmatched ara/id pairs are surfaced as
// quarantine stats, never merged.
const bundle = domain.bundleHadithSources(editions);
const parsed = editions.map((e) => ({
  collection: e.collection,
  arabic: JSON.parse(e.arabicText),
  indonesian: JSON.parse(e.indonesianText),
}));
const arabicByCollection = Object.fromEntries(parsed.map((p) => [p.collection, p.arabic]));
const indonesianByCollection = Object.fromEntries(parsed.map((p) => [p.collection, p.indonesian]));
const corpus = domain.buildHadithCorpus({
  arabic: arabicByCollection,
  indonesian: indonesianByCollection,
});

const gradeStats = domain.corpusGradeStats(corpus);
const unmatched = [...corpus.alignment.values()].reduce((n, s) => n + s.unmatched.length, 0);
const emptySecondary = [...corpus.alignment.values()].reduce((n, s) => n + s.emptySecondary, 0);
const emptyPrimary = [...corpus.alignment.values()].reduce((n, s) => n + s.emptyPrimary, 0);
// Quarantined = everything rejected rather than ingested (the report's "chunks rejected by
// validation" field): unmatched pairs and empty-Arabic rows. Empty-secondary rows are ingested with
// text_id: null, so they are surfaced separately, not here.
const quarantined = unmatched + emptyPrimary;
logger.info("integrity OK", {
  collections: selected.length,
  hadith: corpus.records.length,
  gradeGraded: gradeStats.graded,
  gradeDhaifWins: gradeStats.dhaifWins,
  gradeUngraded: gradeStats.ungraded,
  emptySecondary,
  emptyPrimary,
  unmatched,
});

if (CHECK_ONLY) {
  logger.info("--check passed — store untouched, no LLM/embedding spend");
  process.exit(0);
}

// Wire seams once: the store comes from @app/infra's composition helper — this CLI names the
// connection URL and receives the seam, never importing a database client — and one runner feeds
// both the RagStore and the report path.
const store = app.resolvePostgresStore(databaseUrl, { logger });
const config = app.loadProviderConfig();
// Batch retry policy: an offline ingest must ride out a vendor's per-minute window rather than give
// up on the interactive timeout.
const { provider: embedder } = app.resolveRole(config, "embedder", {
  env: process.env,
  retrySchedule: app.batchRetrySchedule,
});
const { provider: summarizerProvider, missingKeys } = app.resolveRole(config, "cheap", {
  env: process.env,
  retrySchedule: app.batchRetrySchedule,
});
if (missingKeys.length > 0) {
  fail(`no API key for the cheap role (needed for section summaries): ${missingKeys.join(", ")}`);
}

// Archive raw bytes before persisting derived rows.
const archive = await archiveRawSources({
  sources: {
    surahListText: "",
    surahFiles: [],
    morphologyText: "",
    editionFiles: editions.flatMap((e) => [
      [`ara-${e.collection}.json`, e.arabicText],
      [`ind-${e.collection}.json`, e.indonesianText],
    ]),
  },
  store: createArchiveObjectStore(app.createS3ObjectStore),
  prefix: R2_PREFIX,
  bundle,
  archiveFingerprint: domain.archiveFingerprint,
  log: logger,
});

const reportDir = process.env.HADITH_REPORT_DIR;
if (reportDir) {
  const fs = await import("node:fs/promises");
  await fs.mkdir(reportDir, { recursive: true });
}

const result = await ingest.runIngestion(
  domain.hadithSourceParser(),
  {
    archiveKey: archive.prefix ?? R2_PREFIX,
    raw: bundle,
  },
  {
    store,
    embedder,
    summarizer: domain.hadithSectionSummarizer(summarizerProvider),
    // Persisted pairs carry the domain's stable `hadith-pair:{collection}:{no}` address rather than
    // the runner's source-derived child key.
    pairSink: domain.hadithPairSink(store, domain.hadithPairKeyFor),
    embedBatchSize: 96,
    writeBatchSize: 96,
  },
);

const report = {
  ...result.report,
  quarantined,
  details: {
    ...result.report.details,
    archiveStored: archive.stored,
    archiveKeys: archive.keys.length,
    archivePrefix: archive.prefix,
    collections: selected.length,
    onlyMissing: ONLY_MISSING,
    hadith: corpus.records.length,
    gradeGraded: gradeStats.graded,
    gradeDhaifWins: gradeStats.dhaifWins,
    gradeUngraded: gradeStats.ungraded,
    emptySecondary,
    emptyPrimary,
    unmatched,
  },
};

// Off-Workers bridge: the store seam is Effect-shaped (ADR-0027), so runStoreEffect joins it to the
// CLI's top-level await here, in the composition root.
await ingest.runStoreEffect(
  store.insertEvalRun({
    id: report.runId,
    label: `ingest:hadith ${new Date().toISOString()}`,
    report,
  }),
);

if (reportDir) {
  const fs = await import("node:fs/promises");
  await fs.writeFile(
    resolve(reportDir, `ingest-hadith-${report.runId}.json`),
    JSON.stringify(report, null, 2),
  );
}

logger.info("done", {
  parentsWritten: report.parentsWritten,
  childrenWritten: report.childrenWritten,
  costMicroUsd: report.costMicroUsd,
  llmCalls: report.llmCalls.length,
  runId: report.runId,
});
