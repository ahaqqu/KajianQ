#!/usr/bin/env bun
/**
 * ingest-quran.mjs — the `ingest:quran` Bun CLI (issue #6).
 *
 *   bun run ingest:quran                          # full ingest (needs NEON_DATABASE_URL + API keys)
 *   bun run ingest:quran -- --check               # integrity check only (no LLM/embedding spend)
 *   bun run ingest:quran -- --limit 5             # ingest only the first N surahs
 *
 * Thin composition root (B5): source acquisition lives in
 * `source-acquisition.mjs`, R2 archival in `archive-store.mjs`; this file
 * reads the env/config once, wires the seams, and delegates. Pipeline (all
 * off the request path, per spec §3.2):
 *   1. fetch sources (or reuse the QURAN_SOURCE_DIR cache, offline re-runs);
 *   2. archive the RAW bytes to R2 via the ObjectStore seam (never committed
 *      to the repo — Kemenag redistribution is gated by human prerequisite
 *      #2, noted in NOTICES/DATASETS.md);
 *   3. run the generic ingestion pipeline (`@app/rag-ingest`) — the domain
 *      SourceParser re-parses + integrity-checks (6,236 ayah, 114 surahs,
 *      morphology coverage) from the archived bundle inside the runner, so
 *      the archived bytes are the single source of truth (A3);
 *   4. write the aligned pairs (concept-graph seed for #24) through the
 *      RagStore aligned-pair seam;
 *   5. persist the IngestionReport to `eval_runs` (the report ledger) via
 *      the RagStore batch-report seam.
 *
 * Idempotency: parents upsert by sourceKey, children by (parentId, ordinal),
 * pairs by pairKey, reports by run id — re-running the script is safe by
 * construction.
 */
import { neon } from "@neondatabase/serverless";
import * as app from "@app/infra";
import * as ingest from "@app/rag-ingest";
import * as domain from "@app/kajianq-domain";
import { acquireSources, archiveRawSources, createArchiveObjectStore } from "./archive-store.mjs";

const resolve = (p) => new URL(p, `file://${process.cwd()}/`).pathname;

// ---------------------------------------------------------------------------
// Config: read once at the composition root. No vendor names live here —
// provider roles and credentials are resolved through the config seam.
// ---------------------------------------------------------------------------
const SURAH_BASE =
  process.env.QURAN_SURAH_BASE_URL ??
  "https://raw.githubusercontent.com/hangsbreaker/quran-json/main";
const MORPHOLOGY_URL =
  process.env.QURAN_MORPHOLOGY_URL ??
  "https://raw.githubusercontent.com/cltk/arabic_morphology_quranic-corpus/master/quranic-corpus-morphology-0.4.txt";
const R2_PREFIX = "quran/tanzil-uthmani-kemenag";

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
const LIMIT = (() => {
  const idx = args.indexOf("--limit");
  return idx >= 0 ? Number(args[idx + 1]) : null;
})();

const logger = app.createLogger({ script: "ingest:quran" });

function fail(msg) {
  logger.error(msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

const neonUrl = process.env.NEON_DATABASE_URL;
if (!neonUrl) fail("NEON_DATABASE_URL is not set");

logger.info("starting", {
  mode: CHECK_ONLY ? "integrity-check" : "full-ingestion",
  limit: LIMIT ?? "all",
});

const sources = await acquireSources({
  surahCount: LIMIT ?? domain.TOTAL_SURAHS,
  log: logger,
  surahListUrl: `${SURAH_BASE}/surah_list.json`,
  surahFileUrl: `${SURAH_BASE}/Surah`,
  morphologyUrl: MORPHOLOGY_URL,
});
const bundle = domain.bundleQuranSources(sources);

// Integrity checks run in every mode, before any spend. With --limit only
// the first LIMIT surah files are ingested — the expected ayah total is
// computed from those files, and `buildCorpus` trims its metadata to the
// ingested subset; a full run gates on the exact Tanzil totals.
const parsedSurahFiles = sources.surahFiles.map((t) => JSON.parse(t));
const expectedAyahs = parsedSurahFiles.reduce(
  (sum, file) => sum + (Array.isArray(file) ? file.length : 0),
  0,
);
const corpus = domain.buildCorpus(
  {
    surahList: JSON.parse(sources.surahListText),
    surahFiles: parsedSurahFiles,
    morphologyText: sources.morphologyText,
  },
  LIMIT ? { surahs: LIMIT, ayahs: expectedAyahs } : undefined,
);

const diffs = domain.corpusWordCountDiffs(corpus);
logger.info("integrity OK", {
  surahs: corpus.surahs.length,
  ayahs: corpus.ayahs.length,
  morphologyAyahs: corpus.morphology.size,
  segmentationDiffs: diffs.length,
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
  fail(`no API key for the cheap role (needed for surah summaries): ${missingKeys.join(", ")}`);
}

// Archive raw bytes before persisting derived rows.
const archive = await archiveRawSources({
  sources,
  store: createArchiveObjectStore(app.createS3ObjectStore),
  prefix: R2_PREFIX,
  bundle,
  archiveFingerprint: domain.archiveFingerprint,
  log: logger,
});

const reportDir = process.env.QURAN_REPORT_DIR;
if (reportDir) {
  const fs = await import("node:fs/promises");
  await fs.mkdir(reportDir, { recursive: true });
}

// The parser re-parses from the archived bundle (the single source of
// truth); subset runs pass the exact expected totals, full runs rely on
// the parser's full-corpus defaults. The report quotes the corpus numbers.
const result = await ingest.runIngestion(
  domain.quranSourceParser(
    LIMIT ? expectedAyahs : undefined,
    LIMIT ?? undefined,
  ),
  {
    archiveKey: archive.prefix ?? R2_PREFIX,
    raw: bundle,
  },
  {
    store,
    embedder,
    summarizer: domain.surahSummarizer(summarizerProvider),
    // Persisted pairs carry the domain's stable `quran-pair:N:M` address —
    // the key #24's concept-graph build resolves against — rather than the
    // runner's source-derived child key.
    pairSink: domain.quranPairSink(store, (input) =>
      domain.ayahPairId(Number(input.citation.surah), Number(input.citation.ayah)),
    ),
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
    surahs: corpus.surahs.length,
    ayahs: corpus.ayahs.length,
    morphologyAyahs: corpus.morphology.size,
    segmentationDiffs: diffs.length,
  },
};

await store.insertEvalRun({
  id: report.runId,
  label: `ingest:quran ${new Date().toISOString()}`,
  report,
});

if (reportDir) {
  const fs = await import("node:fs/promises");
  await fs.writeFile(
    resolve(reportDir, `ingest-quran-${report.runId}.json`),
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