#!/usr/bin/env bun
/**
 * ingest-hadith.mjs — the `ingest:hadith` Bun CLI (issue #7).
 *
 *   bun run ingest:hadith                          # full ingest (needs NEON_DATABASE_URL + API keys)
 *   bun run ingest:hadith -- --check               # integrity check only (no LLM/embedding spend)
 *   bun run ingest:hadith -- --limit 2             # ingest only the first N collections
 *
 * Thin composition root (B5): source acquisition lives in
 * `source-acquisition.mjs`, R2 archival in `archive-store.mjs`; this file
 * reads the env/config once, wires the seams, and delegates. Pipeline (all
 * off the request path, per spec §3.2):
 *   1. fetch the (Arabic, Indonesian) edition files per collection (or
 *      reuse the HADITH_SOURCE_DIR cache, offline re-runs);
 *   2. archive the RAW bytes to R2 via the ObjectStore seam (never committed
 *      to the repo; noted in NOTICES/DATASETS.md);
 *   3. run the generic ingestion pipeline (`@app/rag-ingest`) — the domain
 *      SourceParser re-parses + integrity-checks (edition shape, ara/id
 *      alignment, duplicate keys) from the archived bundle inside the
 *      runner, so the archived bytes are the single source of truth (A3);
 *   4. write the aligned pairs (concept-graph seed for #24) through the
 *      RagStore aligned-pair seam;
 *   5. persist the IngestionReport to `eval_runs` (the report ledger) via
 *      the RagStore batch-report seam.
 *
 * Source: fawazahmed0/hadith-api editions (Unlicense; ADR-0025). Idempotency:
 * parents upsert by sourceKey, children by (parentId, ordinal), pairs by
 * pairKey, reports by run id — re-running the script is safe by construction.
 */
import { neon } from "@neondatabase/serverless";
import * as app from "@app/infra";
import * as ingest from "@app/rag-ingest";
import * as domain from "@app/kajianq-domain";
import { acquireFiles, archiveRawSources, createArchiveObjectStore } from "./archive-store.mjs";

const resolve = (p) => new URL(p, `file://${process.cwd()}/`).pathname;

// ---------------------------------------------------------------------------
// Config: read once at the composition root. No vendor names live here —
// provider roles and credentials are resolved through the config seam.
// ---------------------------------------------------------------------------
const EDITIONS_BASE =
  process.env.HADITH_EDITIONS_BASE_URL ??
  "https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions";
const R2_PREFIX = "hadith/fawazahmed0-hadith-api";

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
const LIMIT = (() => {
  const idx = args.indexOf("--limit");
  return idx >= 0 ? Number(args[idx + 1]) : null;
})();

const logger = app.createLogger({ script: "ingest:hadith" });

function fail(msg) {
  logger.error(msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

const neonUrl = process.env.NEON_DATABASE_URL;
if (!neonUrl && !CHECK_ONLY) fail("NEON_DATABASE_URL is not set");

const collections = (LIMIT ? domain.HADITH_COLLECTIONS.slice(0, LIMIT) : domain.HADITH_COLLECTIONS);
logger.info("starting", {
  mode: CHECK_ONLY ? "integrity-check" : "full-ingestion",
  collections,
});

// Editions carry the collection name inside their JSON (parsed by the domain
// layer); acquisition stays name-agnostic.
const cacheDir = process.env.HADITH_SOURCE_DIR;
const entries = collections.flatMap((c) => [
  { url: `${EDITIONS_BASE}/ara-${c}.json`, cacheFile: `ara-${c}.json` },
  { url: `${EDITIONS_BASE}/ind-${c}.json`, cacheFile: `ind-${c}.json` },
]);
const texts = await acquireFiles(entries, { log: logger, cacheDir });

const editions = collections.map((c, i) => ({
  collection: c,
  arabicText: texts[i * 2],
  indonesianText: texts[i * 2 + 1],
}));

// Integrity checks run in every mode, before any spend. --limit subsets by
// collection; the parsed corpus gates on what is actually ingested, while
// unmatched ara/id pairs are surfaced as quarantine stats (never merged).
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
logger.info("integrity OK", {
  collections: collections.length,
  hadith: corpus.records.length,
  gradeGraded: gradeStats.graded,
  gradeDhaifWins: gradeStats.dhaifWins,
  gradeUngraded: gradeStats.ungraded,
  emptySecondary,
  unmatched,
});

if (CHECK_ONLY) {
  logger.info("--check passed — store untouched, no LLM/embedding spend");
  process.exit(0);
}

// Wire seams once — one sql runner feeds both the RagStore and the report
// path (C1: a single `neon()` handle per run).
const sql = neon(neonUrl);
const store = app.createRagStore("neon", sql, { logger });
const config = app.loadProviderConfig();
const { provider: embedder } = app.resolveRole(config, "embedder", { env: process.env });
const { provider: summarizerProvider, missingKeys } = app.resolveRole(config, "cheap", {
  env: process.env,
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

// The parser re-parses from the archived bundle (the single source of
// truth); the report quotes the corpus numbers.
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
    // Persisted pairs carry the domain's stable `hadith-pair:{collection}:{no}`
    // address — the key #24's concept-graph build resolves against — rather
    // than the runner's source-derived child key.
    pairSink: domain.hadithPairSink(store, domain.hadithPairKeyFor),
    embedBatchSize: 96,
    writeBatchSize: 96,
  },
);

// Persist the report through the RagStore batch-report seam.
const report = {
  ...result.report,
  details: {
    ...result.report.details,
    archiveStored: archive.stored,
    archiveKeys: archive.keys.length,
    archivePrefix: archive.prefix,
    collections: collections.length,
    hadith: corpus.records.length,
    gradeGraded: gradeStats.graded,
    gradeDhaifWins: gradeStats.dhaifWins,
    gradeUngraded: gradeStats.ungraded,
    emptySecondary,
    unmatched,
  },
};

await store.insertEvalRun({
  id: report.runId,
  label: `ingest:hadith ${new Date().toISOString()}`,
  report,
});

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