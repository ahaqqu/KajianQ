#!/usr/bin/env bun
/**
 * embed-bench-corpus.mjs — source acquisition + probe authoring for the
 * embedding-benchmark CLI (#9). One module owns the real-source fetch +
 * domain parse; the CLI owns config, embedding, scoring, and the report.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import * as domain from "@app/kajianq-domain";
import { acquireFiles, acquireSources } from "../../kajianq-domain/scripts/source-acquisition.mjs";

const SURAH_BASE =
  process.env.QURAN_SURAH_BASE_URL ??
  "https://raw.githubusercontent.com/hangsbreaker/quran-json/main";
const EDITIONS_BASE =
  process.env.HADITH_EDITIONS_BASE_URL ??
  "https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions";

/**
 * Fetch the real sources (QURAN_SOURCE_DIR / HADITH_SOURCE_DIR cache dirs
 * are honored by the acquisition helper) and parse them into benchmark docs
 * through the domain pack's ingest-grade parsers. Group A is the Quran
 * group (surahs), group B the hadith collections — the caps are engine-side
 * opaque counts, resolved to the domain's vocabulary here.
 */
export async function buildBenchmarkCorpus({ groupACap, groupBCap, docBudget, log }) {
  const surahCount = groupACap === undefined ? domain.TOTAL_SURAHS : groupACap;
  const collections = domain.HADITH_COLLECTIONS.slice(
    0,
    groupBCap === undefined ? domain.HADITH_COLLECTIONS.length : groupBCap,
  );
  let quranDocs = [];
  if (surahCount > 0) {
    const sources = await acquireSources({
      surahCount,
      log,
      surahListUrl: `${SURAH_BASE}/surah_list.json`,
      morphologyUrl:
        process.env.QURAN_MORPHOLOGY_URL ??
        "https://raw.githubusercontent.com/cltk/arabic_morphology_quranic-corpus/master/quranic-corpus-morphology-0.4.txt",
    });
    const ayahs = sources.surahFiles.flatMap((t) => domain.parseSurahFile(JSON.parse(t)));
    quranDocs = domain.quranBenchDocs(ayahs);
    log.info("quran docs ready", { count: quranDocs.length });
  }

  const editionEntries = collections.flatMap((c) => [
    { url: `${EDITIONS_BASE}/ara-${c}.json`, cacheFile: `ara-${c}.json` },
    { url: `${EDITIONS_BASE}/ind-${c}.json`, cacheFile: `ind-${c}.json` },
  ]);
  const editionTexts = await acquireFiles(editionEntries, {
    log,
    cacheDir: process.env.HADITH_SOURCE_DIR,
  });
  const arabic = {};
  const indonesian = {};
  for (let i = 0; i < collections.length; i += 1) {
    const c = collections[i];
    arabic[c] = JSON.parse(editionTexts[i * 2]);
    indonesian[c] = JSON.parse(editionTexts[i * 2 + 1]);
  }
  // No per-collection count gate: edition sizes drift upstream and unmatched
  // ara/id pairs quarantine inside buildHadithCorpus (the ingest CLI's exact
  // posture) — the benchmark's corpus shape is reported via the fingerprint.
  const corpus = domain.buildHadithCorpus({ arabic, indonesian });
  const hadithDocs = domain.hadithBenchDocs(corpus.records);
  const unmatched = [...corpus.alignment.values()].reduce((n, s) => n + s.unmatched.length, 0);
  if (unmatched > 0) {
    log.warn("unmatched ara/id pairs quarantined (not force-merged)", { unmatched });
  }
  log.info("hadith docs ready", { count: hadithDocs.length });

  // Free-tier embed-content quota counts ITEMS per minute, so the gate runs
  // over a deterministic stratified subset (preserving each group's share)
  // sized by docBudget; probes are self-retrieval over the same docs.
  const allDocs =
    docBudget !== undefined && docBudget > 0 && docBudget < quranDocs.length + hadithDocs.length
      ? domain.stratifiedSubset(quranDocs, hadithDocs, { total: docBudget })
      : [...quranDocs, ...hadithDocs];
  if (allDocs.length < quranDocs.length + hadithDocs.length) {
    log.info("stratified subset selected", {
      from: quranDocs.length + hadithDocs.length,
      kept: allDocs.length,
      budget: docBudget,
    });
  }
  return { allDocs, fingerprint: domain.corpusFingerprint(allDocs), surahCount, collections };
}

/**
 * Load the versioned probe fixture when present, else author deterministic
 * stride probes and persist them (the committed fixture is the record).
 */
export function resolveProbes({ evalpkg, domain: dom, probePath, fingerprint, allDocs }) {
  try {
    const fixture = evalpkg.parseProbeSet(JSON.parse(readFileSync(probePath, "utf8")), probePath);
    if (fixture.corpusFingerprint !== fingerprint) {
      throw new Error(
        `probe fixture ${fixture.id} was authored for corpus ${fixture.corpusFingerprint}, ` +
          `current corpus is ${fingerprint} — re-author the probes`,
      );
    }
    return {
      probes: {
        crossLingual: fixture.crossLingual,
        monolingual: fixture.monolingual,
        idFallback: [],
      },
      source: `fixture ${probePath}`,
    };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    const probes = dom.authorProbes(
      allDocs,
      { crossLingual: 200, monolingual: 200, idTrack: 0 },
      fingerprint,
    );
    mkdirSync(dirname(probePath), { recursive: true });
    writeFileSync(
      probePath,
      JSON.stringify(
        {
          id: "embed-bench-probes-v0",
          corpusFingerprint: fingerprint,
          crossLingual: probes.crossLingual,
          monolingual: probes.monolingual,
        },
        null,
        2,
      ),
    );
    return {
      probes,
      source: `authored + written ${probePath} (deterministic stride sample)`,
    };
  }
}

/** Read a fixture file as parsed JSON (path resolved by the caller). */
export function readFixtureJson(path, source) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Write the JSON report, creating the parent dir (the CLI's only write). */
export function writeReportFile(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
}

/** cwd-resolved absolute path (the CLI has no other path need). */
export function fromCwd(p) {
  return resolvePath(process.cwd(), p);
}

void domain;
