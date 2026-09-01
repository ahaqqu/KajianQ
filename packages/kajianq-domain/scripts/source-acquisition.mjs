/**
 * source-acquisition.mjs — source fetching for the ingest CLIs (issues #6, #7).
 *
 * Fetch (or reuse a local cache when the run's SOURCE_DIR env is set) remote
 * source files: retry with exponential backoff, bounded concurrency (B4),
 * and a hard per-fetch timeout — a transient 429/5xx or a network blip must
 * not fail a multi-minute ingestion run.
 */

const FETCH_BACKOFF_MS = [500, 1_000, 2_000, 4_000];
const FETCH_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 30_000;

const resolve = (p) => new URL(p, `file://${process.cwd()}/`).pathname;

async function fetchWithRetry(url, attempt, log) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "kajianq-ingest/0.1" },
    });
    if (!res.ok) {
      throw new Error(`fetch ${url} → ${res.status}`);
    }
    return res.text();
  } catch (err) {
    if (attempt < FETCH_BACKOFF_MS.length) {
      const delay = FETCH_BACKOFF_MS[attempt] ?? 1_000;
      log.warn(`fetch retry`, { url, attempt, delayMs: delay, error: String(err) });
      await new Promise((r) => setTimeout(r, delay));
      return fetchWithRetry(url, attempt + 1, log);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOrCache(url, cacheFile, log, cacheDir) {
  if (cacheDir) {
    try {
      const { readFile } = await import("node:fs/promises");
      return await readFile(resolve(cacheDir, cacheFile), "utf8");
    } catch (err) {
      // A misconfigured cache dir must fail loudly, not silently fall back
      // to the network (C2); only "file absent" proceeds to fetch.
      if (err.code !== "ENOENT") throw err;
      // fall through to fetch
    }
  }
  return fetchWithRetry(url, 0, log);
}

/**
 * Acquire a list of remote files: `{url, cacheFile}` entries fetched with
 * bounded concurrency and order-stable results (position i of the result
 * corresponds to entry i, whatever the batch timing). The shared cache dir
 * comes from the caller (per-run env), keeping this helper run-agnostic.
 */
export async function acquireFiles(entries, { log, cacheDir }) {
  const results = new Array(entries.length);
  for (let i = 0; i < entries.length; i += FETCH_CONCURRENCY) {
    const slice = entries.slice(i, i + FETCH_CONCURRENCY);
    const batch = await Promise.all(
      slice.map(({ url, cacheFile }) => fetchOrCache(url, cacheFile, log, cacheDir)),
    );
    for (const [j, text] of batch.entries()) {
      results[i + j] = text;
    }
    log.info("fetched batch", { done: Math.min(i + slice.length, entries.length), total: entries.length });
  }
  return results;
}

/**
 * Acquire the Quran sources: the surah list, the first `surahCount` surah
 * files, and the morphology text. Returns the raw texts verbatim — parsing
 * and integrity-checking belong to the domain layer, not acquisition.
 */
export async function acquireSources({ surahCount, log, surahListUrl, surahFileUrl, morphologyUrl }) {
  const cacheDir = process.env.QURAN_SOURCE_DIR;
  const surahListText = await fetchOrCache(surahListUrl, "surah_list.json", log, cacheDir);

  const urls = Array.from({ length: surahCount }, (_, i) => ({
    url: `${surahListUrl.replace(/surah_list\.json$/, "")}Surah/${i + 1}.json`,
    cacheFile: `Surah/${i + 1}.json`,
  }));

  const surahFiles = await acquireFiles(urls, { log, cacheDir });

  const morphologyText = await fetchOrCache(morphologyUrl, "morphology.txt", log, cacheDir);
  return { surahListText, surahFiles, morphologyText };
}