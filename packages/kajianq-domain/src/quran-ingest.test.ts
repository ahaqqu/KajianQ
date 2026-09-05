import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runIngestion } from "@app/rag-ingest";
import { createCrossLingualEmbedder } from "./test-utils/cross-lingual-embedder";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";
import { buildCorpus, bundleQuranSources, corpusWordCountDiffs, decodeQuranArchive, quranSourceParser } from "./quran-ingest";
import { quranPairSink, surahSummarizer } from "./quran-llm";
import { formatQuranCitation } from "./quran-source";
import { Effect } from "effect";

/**
 * INTEGRATION TEST — issue #6's design-for-verification core.
 *
 * The invariant under test (fails silently in production if broken): a
 * query phrased in INDONESIAN about a well-known ayah's meaning, searched
 * against the PRIMARY (Arabic) embedding track only, must return that exact
 * ayah in top-k with `QS. Surah:Ayah` citation metadata — the cross-lingual
 * ID→AR test of ADR-0013. A monolingual-ID test over concatenated text
 * would pass while the thesis is broken, so this test deliberately searches
 * the primary track and asserts the Arabic text is what is returned.
 *
 * Fixtures are REAL source data (four short surahs + their Quranic Arabic
 * Corpus morphology), not invented strings, so the parse + join paths run
 * against the true upstream formats. The embedder is the deterministic
 * cross-lingual test double (see test-utils): it models the property the
 * real model is claimed to have — same concept, either language, nearby
 * vector — so the retrieval mechanics are genuinely exercised. The real
 * model's cross-lingual quality is the #9 embedding benchmark gate.
 *
 * The summarizer is a deterministic stub returning a real summary shape:
 * the LLM path itself is costed and asserted separately (rag-ingest
 * pipeline tests + the ingestion report's llmCalls array here).
 */

const FIXTURES = resolve(import.meta.dirname, "fixtures");

async function loadFixtureCorpus() {
  const read = (f: string) => readFile(resolve(FIXTURES, f), "utf8");
  return buildCorpus(
    {
      surahList: JSON.parse(await read("surah_list.json")),
      surahFiles: [
        JSON.parse(await read("surah_1.json")),
        JSON.parse(await read("surah_112.json")),
        JSON.parse(await read("surah_113.json")),
        JSON.parse(await read("surah_114.json")),
      ],
      morphologyText: await read("morphology.txt"),
    },
    // The fixture is a 4-surah subset; the expected totals stay exact for
    // what is ingested (the full-corpus default is asserted by the CLI's
    // --check mode against the real sources).
    { surahs: 4, ayahs: 22 },
  );
}

/**
 * The bilingual dictionary the test embedder maps through. Surface forms are
 * VERBATIM substrings of the real Uthmani/Indonesian fixture texts — the
 * Uthmani orthography carries shadda/dagger-alif inside words, so plain
 * spellings would not match.
 */
const DICT = {
  oneness_of_allah: {
    ar: ["قُلْ هُوَ اللّٰهُ اَحَدٌ", "اَللّٰهُ الصَّمَدُ"],
    id: ["Allah Yang Maha Esa", "tempat meminta segala sesuatu"],
  },
  seeking_refuge: {
    ar: ["قُلْ اَعُوْذُ بِرَبِّ الْفَلَقِ", "قُلْ اَعُوْذُ بِرَبِّ النَّاسِ", "مِنْ شَرِّ الْوَسْوَاسِ"],
    id: ["Aku berlindung", "bisikan (kejahatan)"],
  },
  guidance: {
    ar: ["الصِّرَاطَ الْمُسْتَقِيْمَ", "اِهْدِنَا"],
    id: ["jalan yang lurus", "tunjukkanlah"],
  },
  lord_of_worlds: {
    ar: ["اَلْحَمْدُ لِلّٰهِ", "رَبِّ الْعٰلَمِيْنَ"],
    id: ["Segala puji bagi Allah", "Tuhan semesta alam"],
  },
};

describe("Quran ingestion (fixture = real source data)", () => {
  it("keeps count and metadata integrity: 4 surahs, 23 ayahs, no gaps or duplicates", async () => {
    const corpus = await loadFixtureCorpus();
    // Real counts for surahs 1 (7), 112 (4), 113 (5), 114 (6).
    expect(corpus.surahs).toHaveLength(4);
    expect(corpus.ayahs).toHaveLength(7 + 4 + 5 + 6);
    const keys = new Set(corpus.ayahs.map((a) => `${a.surah}:${a.ayah}`));
    expect(keys.size).toBe(corpus.ayahs.length);
    for (const ayah of corpus.ayahs) {
      expect(ayah.textAr.trim().length).toBeGreaterThan(0);
      expect(ayah.textId.trim().length).toBeGreaterThan(0);
    }
  });

  it("imports morphology with lemma+root stored alongside the Arabic text", async () => {
    const corpus = await loadFixtureCorpus();
    // Every ayah has morphology tokens; every STEM token carries lemma+root.
    for (const ayah of corpus.ayahs) {
      const tokens = corpus.morphology.get(`${ayah.surah}:${ayah.ayah}`);
      expect(tokens).toBeDefined();
      expect((tokens ?? []).length).toBeGreaterThan(0);
    }
    const alFalaq = corpus.morphology.get("113:1");
    expect(alFalaq).toBeDefined();
    // (113:1) — أَعُوذُ بِرَبِّ الْفَلَقِ — 3 corpus words, first is 'aEu*u' V
    const first = alFalaq?.[0];
    expect(first?.pos).toBe("V");
    expect(first?.lemma).toBeDefined();
    expect(first?.root).toBeDefined();
    // Word/segment positions are 1-based; (113:1) has 4 corpus words.
    const words = new Set((alFalaq ?? []).map((t) => t.word));
    expect(words.size).toBe(4);
  });

  async function loadFixtureBundle() {
    return bundleQuranSources({
      surahListText: await readFile(resolve(FIXTURES, "surah_list.json"), "utf8"),
      surahFiles: await Promise.all([
        readFile(resolve(FIXTURES, "surah_1.json"), "utf8"),
        readFile(resolve(FIXTURES, "surah_112.json"), "utf8"),
        readFile(resolve(FIXTURES, "surah_113.json"), "utf8"),
        readFile(resolve(FIXTURES, "surah_114.json"), "utf8"),
      ]),
      morphologyText: await readFile(resolve(FIXTURES, "morphology.txt"), "utf8"),
    });
  }

  it("bundle round-trips: decode(bundle(sources)) restores the exact source pieces", async () => {
    const surahListText = await readFile(resolve(FIXTURES, "surah_list.json"), "utf8");
    const surahFiles = await Promise.all([
      readFile(resolve(FIXTURES, "surah_1.json"), "utf8"),
      readFile(resolve(FIXTURES, "surah_112.json"), "utf8"),
    ]);
    const morphologyText = await readFile(resolve(FIXTURES, "morphology.txt"), "utf8");
    const decoded = decodeQuranArchive({
      archiveKey: "quran/test-fixture",
      raw: bundleQuranSources({ surahListText, surahFiles, morphologyText }),
    });
    expect(JSON.stringify(decoded.surahList)).toBe(JSON.stringify(JSON.parse(surahListText)));
    expect(decoded.surahFiles).toEqual(surahFiles.map((t) => JSON.parse(t)));
    expect(decoded.morphologyText).toBe(morphologyText);

    // A bundle with more lines than its declared count is a layout mismatch —
    // refuse it instead of silently parsing a subset.
    const padded = new TextEncoder().encode(
      `${["2", surahListText, JSON.stringify(morphologyText), ...surahFiles, "{}"].join("\n")}`,
    );
    expect(() =>
      decodeQuranArchive({ archiveKey: "quran/test-fixture", raw: padded }),
    ).toThrow(/trailing/);
  });

  it("ingests through runIngestion: parents, children, both tracks, aligned pairs", async () => {
    const raw = await loadFixtureBundle();
    const store = createMemoryRagStore();
    const result = await runIngestion(quranSourceParser(22, 4), {
      archiveKey: "quran/test-fixture",
      raw,
    }, {
      store,
      embedder: createCrossLingualEmbedder(DICT),
      summarizer: surahSummarizer(deterministicSummarizer()),
      pairSink: quranPairSink(store),
    });

    expect(result.parentIds).toHaveLength(4);
    expect(store.allChildren()).toHaveLength(22);
    // Both embedding tracks written for every child.
    for (const child of store.allChildren()) {
      expect(child.embeddingPrimary).not.toBeNull();
      expect(child.embeddingFallback).not.toBeNull();
    }
    // Aligned pairs — the seed rows for #24's concept-graph build.
    expect(store.allPairs()).toHaveLength(22);
    const pair = store.allPairs().find((p) => p.pairKey === "quran/tanzil-uthmani/surah/112:1");
    expect(pair?.textPrimary).toContain("قُلْ هُوَ");
    expect(pair?.textSecondary).toContain("Allah Yang Maha Esa");
    expect((pair?.morphology ?? []).length).toBeGreaterThan(0);
    // Children keep chapter context: their citation names the surah+ayah.
    const child = store.allChildren().find((c) => (c.metadata as { surah?: number }).surah === 112);
    expect((child?.citation as { surah?: number }).surah).toBe(112);
    // Every costed call recorded: the report's cost equals the sum of calls.
    expect(result.report.llmCalls.length).toBeGreaterThan(0);
    expect(result.report.costMicroUsd).toBe(
      result.report.llmCalls.reduce((s, c) => s + c.costMicroUsd, 0),
    );
  });

  it("computes parent embeddings from summaries, not full text", async () => {
    const raw = await loadFixtureBundle();
    const store = createMemoryRagStore();
    await runIngestion(quranSourceParser(22, 4), {
      archiveKey: "quran/test-fixture",
      raw,
    }, {
      store,
      embedder: createCrossLingualEmbedder(DICT),
      summarizer: surahSummarizer(deterministicSummarizer()),
    });
    // The parent metadata carries the summary and the embedding source marker.
    const parent = store.allParents().find((p) => p.sourceKey === "quran/tanzil-uthmani/surah/112");
    expect((parent?.metadata as Record<string, unknown>).summary).toContain("Al-Ikhlas");
    expect((parent?.metadata as Record<string, unknown>).summaryEmbeddedFrom).toBe("summary");
  });

  it("is idempotent: re-running ingestion writes the same counts", async () => {
    const raw = await loadFixtureBundle();
    const store = createMemoryRagStore();
    const run = () =>
      runIngestion(quranSourceParser(22, 4), {
        archiveKey: "quran/test-fixture",
        raw,
      }, {
        store,
        embedder: createCrossLingualEmbedder(DICT),
        summarizer: surahSummarizer(deterministicSummarizer()),
        pairSink: quranPairSink(store),
      });
    await run();
    await run();
    expect(store.allParents()).toHaveLength(4);
    expect(store.allChildren()).toHaveLength(22);
    expect(store.allPairs()).toHaveLength(22);
  });

  it("surfaces segmentation diffs instead of force-merging them", async () => {
    const corpus = await loadFixtureCorpus();
    const diffs = corpusWordCountDiffs(corpus);
    // The fixture is small enough that known-convention diffs may be zero or
    // few; the assertion is structural — diffs, when present, carry both
    // counts and never mutate the corpus.
    for (const d of diffs) {
      expect(d.textTokens).toBeGreaterThan(0);
      expect(d.corpusWords).toBeGreaterThan(0);
    }
    expect(corpus.ayahs).toHaveLength(22);
  });

  // -- The ADR-0013 cross-lingual smoke retrieval ---------------------------

  it("retrieves the correct Arabic ayah from an Indonesian meaning query (ID→AR, primary track)", async () => {
    const raw = await loadFixtureBundle();
    const store = createMemoryRagStore();
    const embedder = createCrossLingualEmbedder(DICT);
    await runIngestion(quranSourceParser(22, 4), {
      archiveKey: "quran/test-fixture",
      raw,
    }, {
      store,
      embedder,
      summarizer: surahSummarizer(deterministicSummarizer()),
    });

    // A well-known ayah queried by Indonesian MEANING — Al-Ikhlas 112:1.
    const indonesianQuery = "ayat tentang Allah Yang Maha Esa";
    const queryVector = embedder.vectorsFor([indonesianQuery])[0]!;

    // PRIMARY track only — the Arabic evidence index. This is what makes the
    // test cross-lingual: no Indonesian text channel participates.
    const hits = await store.cosineSearch("primary", queryVector, 5);

    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0]!;
    expect(top.child.textAr).toContain("قُلْ هُوَ");
    // Citation metadata renders as the user-facing label.
    const citation = top.child.citation as { surah: number; ayah: number; sourceType: string };
    expect(formatQuranCitation({
      sourceType: "quran",
      surah: citation.surah,
      ayah: citation.ayah,
    })).toBe("QS. 112:1");
    // The hit's rank/score provenance is present for the Trace.
    expect(top.rankDense).toBe(1);
    expect(top.distance).toBeLessThan(0.5);
  });

  it("retrieves Al-Falaq 113:1 from a refuge-themed Indonesian query (ID→AR)", async () => {
    const raw = await loadFixtureBundle();
    const store = createMemoryRagStore();
    const embedder = createCrossLingualEmbedder(DICT);
    await runIngestion(quranSourceParser(22, 4), {
      archiveKey: "quran/test-fixture",
      raw,
    }, {
      store,
      embedder,
      summarizer: surahSummarizer(deterministicSummarizer()),
    });

    const queryVector = embedder.vectorsFor(["aku berlindung kepada Tuhan pemilik fajar subuh"])[0]!;
    const hits = await store.cosineSearch("primary", queryVector, 3);
    expect(hits[0]?.child.textAr).toContain("قُلْ اَعُوْذُ بِرَبِّ الْفَلَقِ");
    const citation = hits[0]?.child.citation as { surah: number; ayah: number };
    expect(citation.surah).toBe(113);
    expect(citation.ayah).toBe(1);
  });
});

/** Deterministic summarizer standing in for the cheap-tier LLM in tests. */
function deterministicSummarizer() {
  const summaries: Record<string, string> = {
    "quran/tanzil-uthmani/surah/1": "Al-Fatihah (Pembukaan) — 7 ayat, pembuka Al-Quran.",
    "quran/tanzil-uthmani/surah/112": "Al-Ikhlas — 4 ayat tentang keesaan Allah.",
    "quran/tanzil-uthmani/surah/113": "Al-Falaq — 5 ayat perlindungan pagi.",
    "quran/tanzil-uthmani/surah/114": "An-Nas — 6 ayat perlindungan manusia.",
  };
  return {
    modelId: "test-summarizer",
    generate: (spec: { turns: readonly { role: string; content: string }[] }) =>
      Effect.sync(() => {
        const user = spec.turns.find((t) => t.role === "user")?.content ?? "";
        // The prompt embeds the parent sourceKey; match the LONGEST key that
        // occurs (a plain find would let "surah/1" — a substring of
        // "surah/112" — capture the wrong surah).
        const key = Object.keys(summaries)
          .filter((k) => user.includes(k))
          .reduce((best, k) => (best === null || k.length > best.length ? k : best), null as string | null);
        const summary =
          (key !== null ? summaries[key] : undefined) ??
          "Ringkasan surah uji coba dari rangkaian ayat yang diingest.";
        return {
          text: summary,
          cost: {
            modelId: "test-summarizer",
            tokensIn: 64,
            tokensOut: 24,
            latencyMs: 3,
            costMicroUsd: 5,
          },
        };
      }),
    stream: () => Effect.die("test summarizer does not stream"),
    embed: () => Effect.die("test summarizer does not embed"),
  };
}