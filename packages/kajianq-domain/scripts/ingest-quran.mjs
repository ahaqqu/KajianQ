#!/usr/bin/env bun
/**
 * ingest-quran.mjs — the `ingest:quran` Bun CLI (issue #6).
 *
 *   bun run ingest:quran                          # full ingest (needs NEON_DATABASE_URL + GEMINI_API_KEY)
 *   bun run ingest:quran -- --check               # integrity check only (no LLM/embedding spend)
 *   bun run ingest:quran -- --limit 5             # ingest only the first N surahs
 *
 * Pipeline (all off the request path, per spec §3.2):
 *   1. fetch sources (Uthmani Arabic + Indonesian translation per surah,
 *      surah list, Quranic Arabic Corpus morphology) — or reuse a local cache
 *      directory when set via QURAN_SOURCE_DIR (offline re-runs);
 *   2. archive the RAW bytes to R2 via the ObjectStore seam (config-driven,
 *      never committed to the repo — Kemenag redistribution is gated by
 *      human prerequisite #2, noted in NOTICES/DATASETS.md);
 *   3. parse + integrity-check (6,236 ayah, 114 surahs, morphology coverage);
 *   4. run the generic ingestion pipeline (`@app/rag-ingest`) with the domain
 *      parser, the cheap-tier summarizer, and the `embedder` role Provider;
 *   5. write the aligned pairs (concept-graph seed for #24) through the
 *      RagStore aligned-pair seam;
 *   6. persist the IngestionReport to `eval_runs` (the report ledger) and
 *      print it.
 *
 * Idempotency: parents upsert by sourceKey, children by (parentId, ordinal),
 * pairs by pairKey — re-running the script is safe by construction.
 */
import { neon } from "@neondatabase/serverless";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRagStore, loadProviderConfig, resolveRole } from "@app/infra";
import { runIngestion } from "@app/rag-ingest";
import { quranSourceParser, quranPairSink, surahSummarizer, buildCorpus, corpusWordCountDiffs } from "@app/kajianq-domain";

const resolve = (p) => new URL(p, `file://${process.cwd()}/`).pathname;

// ---------------------------------------------------------------------------
// Config (environment-driven; no vendor names in this script — the Provider
// seam resolves models from the checked-in provider config).
// ---------------------------------------------------------------------------

const SURAH_BASE = process.env.QURAN_SURAH_BASE_URL ?? "https://raw.githubusercontent.com/hangsbreaker/quran-json/main";
const SURAH_LIST_URL = `${SURAH_BASE}/surah_list.json`;
const MORPHOLOGY_URL =
  process.env.QURAN_MORPHOLOGY_URL ??
  "https://raw.githubusercontent.com/cltk/arabic_morphology_quranic-corpus/master/quranic-corpus-morphology-0.4.txt";
const TOTAL_SURAHS = 114;
const R2_PREFIX = "quran/tanzil-uthmani-kemenag";

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
const LIMIT = (() => {
  const idx = args.indexOf("--limit");
  return idx >= 0 ? Number(args[idx + 1]) : null;
})();

function fail(msg) {
  console.error(`ingest:quran: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Source acquisition: fetch (or local cache) + raw archive to R2.
// ---------------------------------------------------------------------------

async function fetchOrCache(url, cacheFile) {
  const cacheDir = process.env.QURAN_SOURCE_DIR;
  if (cacheDir) {
    try {
      return await readFile(resolve(cacheDir, cacheFile), "utf8");
    } catch {
      // fall through to fetch
    }
  }
  const res = await fetch(url);
  if (!res.ok) fail(`fetch ${url} → ${res.status}`);
  return res.text();
}

async function acquireSources() {
  const surahCount = LIMIT ?? TOTAL_SURAHS;
  const surahListText = await fetchOrCache(SURAH_LIST_URL, "surah_list.json");
  const surahFiles = [];
  for (let i = 1; i <= surahCount; i += 1) {
    surahFiles.push(
      await fetchOrCache(`${SURAH_BASE}/Surah/${i}.json`, `Surah/${i}.json`),
    );
    if (i % 20 === 0 || i === surahCount) console.log(`ingest:quran: fetched ${i}/${surahCount} surah files`);
  }
  const morphologyText = await fetchOrCache(MORPHOLOGY_URL, "morphology.txt");
  return { surahListText, surahFiles, morphologyText };
}

/**
 * Archive the raw source bytes through the ObjectStore seam. Uses the R2
 * S3-compatible API from env credentials (like r2-verify.mjs) — the Worker's
 * bound bucket is not reachable from this CLI process. When R2 credentials
 * are absent the archive step is skipped and reported, never silently
 * faked: the run logs the skip and marks `archiveStored: false`.
 */
async function archiveRawSources(sources) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_STAGING ?? "kajianq-raw-staging";
  if (!accountId || !accessKeyId || !secretAccessKey) {
    console.log("ingest:quran: R2 credentials absent — raw archive NOT stored (archiveStored: false)");
    return { stored: false, keys: [] };
  }
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  const keys = [];
  const puts = [
    [`${R2_PREFIX}/surah_list.json`, sources.surahListText],
    [`${R2_PREFIX}/morphology.txt`, sources.morphologyText],
    ...sources.surahFiles.map((text, i) => [`${R2_PREFIX}/Surah/${i + 1}.json`, text]),
  ];
  for (const [key, body] of puts) {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
    keys.push(key);
  }
  console.log(`ingest:quran: archived ${keys.length} raw source object(s) to R2 prefix ${R2_PREFIX}/`);
  return { stored: true, keys };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

const neonUrl = process.env.NEON_DATABASE_URL;
if (!neonUrl) fail("NEON_DATABASE_URL is not set");

console.log(`ingest:quran: ${CHECK_ONLY ? "integrity check only" : "full ingestion"} (limit: ${LIMIT ?? "all"})`);
const sources = await acquireSources();

const corpus = buildCorpus({
  surahList: JSON.parse(sources.surahListText),
  surahFiles: sources.surahFiles.map((t) => JSON.parse(t)),
  morphologyText: sources.morphologyText,
});

// -- Integrity checks (the fail-loudly gate; runs in every mode) ------------
const diffs = corpusWordCountDiffs(corpus);
console.log(
  `ingest:quran: integrity OK — ${corpus.surahs.length} surahs, ${corpus.ayahs.length} ayahs, ` +
    `morphology covers all ayahs; ${diffs.length} ayah(s) with segmentation diffs (reported, not merged)`,
);
if (diffs.length > 0) {
  console.log(
    `  segmentation diffs (first 10): ${diffs.slice(0, 10).map((d) => `${d.key} text=${d.textTokens}/corpus=${d.corpusWords}`).join(", ")}`,
  );
}

if (CHECK_ONLY) {
  console.log("ingest:quran: --check passed — store untouched, no LLM/embedding spend");
  process.exit(0);
}

// -- Archive raw bytes (immutability duty; AGENTS.md rule 11) --------------
const archive = await archiveRawSources(sources);

// -- Wire the seams ----------------------------------------------------------
const store = createRagStore("neon", neon(neonUrl));
const config = loadProviderConfig();
const { provider: embedder } = resolveRole(config, "embedder", { env: process.env });
const { provider: summarizerProvider, missingKeys } = resolveRole(config, "cheap", { env: process.env });
if (missingKeys.length > 0) {
  console.log(`ingest:quran: summarizer role missing key(s) ${missingKeys.join(", ")} — surah summaries will fail; aborting`);
  fail(`no API key for the cheap role (needed for surah summaries)`);
}

const cacheDir = process.env.QURAN_REPORT_DIR;
if (cacheDir) await mkdir(cacheDir, { recursive: true });

const result = await runIngestion(quranSourceParser(corpus), {
  archiveKey: `${R2_PREFIX}`,
  raw: new TextEncoder().encode(sources.surahFiles.join("\n")),
}, {
  store,
  embedder,
  summarizer: surahSummarizer(summarizerProvider),
  pairSink: quranPairSink(store),
  embedBatchSize: 96,
});

// -- Persist the report (the citable batch record, kajianq-traceability 4) ---
const report = {
  ...result.report,
  details: {
    ...result.report.details,
    archiveStored: archive.stored,
    archiveKeys: archive.keys.length,
    surahs: corpus.surahs.length,
    ayahs: corpus.ayahs.length,
    morphologyAyahs: corpus.morphology.size,
    segmentationDiffs: diffs.length,
  },
};

const sql = neon(neonUrl);
await sql`
  INSERT INTO eval_runs (id, label, report)
  VALUES (
    ${crypto.randomUUID()},
    ${`ingest:quran ${new Date().toISOString()}`},
    ${JSON.stringify(report)}::jsonb
  )
`;
if (cacheDir) {
  await writeFile(resolve(cacheDir, `ingest-quran-${report.runId}.json`), JSON.stringify(report, null, 2));
}

console.log(`ingest:quran: done — ${report.parentsWritten} surah parents, ${report.childrenWritten} ayah children`);
console.log(
  `ingest:quran: cost ${report.costMicroUsd} micro-USD across ${report.llmCalls.length} recorded LLM/embedding call(s)`,
);
console.log(`ingest:quran: report runId ${report.runId} persisted to eval_runs`);