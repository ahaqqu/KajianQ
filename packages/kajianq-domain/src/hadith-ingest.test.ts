import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runIngestion } from "@app/rag-ingest";
import { createCrossLingualEmbedder } from "./test-utils/cross-lingual-embedder";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";
import { bundleHadithSources, decodeHadithArchive, hadithSourceParser } from "./hadith-ingest";
import { hadithPairKeyFor, hadithPairSink, hadithSectionSummarizer } from "./hadith-llm";
import { formatHadithCitation, hadithSourceKey } from "./hadith-source";

/**
 * INTEGRATION TEST — issue #7's design-for-verification core.
 *
 * The invariants under test (fail silently in production if broken):
 *   1. Grade is structured, filterable metadata — a hadith graded Daif by
 *      any grader carries grade "dhaif" on its chunk metadata (ADR-0025
 *      dhaif-wins), so generation can flag weak narrations at retrieval time.
 *   2. A query phrased in INDONESIAN about a hadith's meaning, searched
 *      against the PRIMARY (Arabic) track only, returns that hadith with a
 *      `HR. Collection no. N` citation — the cross-lingual ID→AR thesis of
 *      ADR-0013, on the hadith corpus this time.
 *
 * Fixture: REAL source slice (fawazahmed0/hadith-api, Sunan Abu Dawud book 1
 * "Purification", 7 hadith spanning every grade-mapping branch). The
 * embedder is the deterministic cross-lingual test double; the summarizer a
 * deterministic stub whose cost is asserted through the report.
 */

const FIXTURES = resolve(import.meta.dirname, "fixtures/hadith");

async function loadFixtureBundle() {
  const read = (f: string) => readFile(resolve(FIXTURES, f), "utf8");
  return bundleHadithSources([
    {
      collection: "abudawud",
      arabicText: await read("ara-abudawud-slice.json"),
      indonesianText: await read("ind-abudawud-slice.json"),
    },
  ]);
}

/**
 * The bilingual dictionary the test embedder maps through. Surface forms are
 * VERBATIM substrings of the real fixture texts (Arabic with full
 * diacritics; Indonesian translation as scraped).
 */
const DICT = {
  ablution_intent: {
    ar: ["إِذَا أَرَادَ حَاجَةً", "عَنِ ابْنِ عُمَرَ"],
    id: ["Ibnu Umar", "hendak berhaji atau berumrah"],
  },
  jabir_report: {
    ar: ["عَنْ جَابِرِ بْنِ", "أَبِي الزُّبَيْرِ"],
    id: ["Jabir bin", "Isma'il bin Abdul Malik"],
  },
  isnad_chain: {
    ar: ["حَدَّثَنَا مُوسَى بْنُ إِسْمَاعِيلَ"],
    id: ["Telah menceritakan kepada kami"],
  },
};

async function ingestFixture(store: ReturnType<typeof createMemoryRagStore>) {
  const raw = await loadFixtureBundle();
  return runIngestion(hadithSourceParser({ abudawud: 7 }), {
    archiveKey: "hadith/test-fixture",
    raw,
  }, {
    store,
    embedder: createCrossLingualEmbedder(DICT),
    summarizer: hadithSectionSummarizer(deterministicSummarizer()),
    pairSink: hadithPairSink(store, hadithPairKeyFor),
  });
}

describe("hadith ingestion (fixture = real source data)", () => {
  it("bundle round-trips: decode(bundle(editions)) restores the exact editions", async () => {
    const read = (f: string) => readFile(resolve(FIXTURES, f), "utf8");
    const arabicText = await read("ara-abudawud-slice.json");
    const indonesianText = await read("ind-abudawud-slice.json");
    const decoded = decodeHadithArchive({
      archiveKey: "hadith/test-fixture",
      raw: bundleHadithSources([{ collection: "abudawud", arabicText, indonesianText }]),
    });
    expect(decoded.arabic.abudawud).toEqual(JSON.parse(arabicText));
    expect(decoded.indonesian.abudawud).toEqual(JSON.parse(indonesianText));

    // A bundle declaring more collections than it carries is a layout
    // mismatch — refuse it rather than silently parse a subset.
    const padded = new TextEncoder().encode(
      `2\n${JSON.stringify({ collection: "abudawud", arabic: JSON.parse(arabicText), indonesian: JSON.parse(indonesianText) })}\n`,
    );
    expect(() =>
      decodeHadithArchive({ archiveKey: "hadith/test-fixture", raw: padded }),
    ).toThrow(/expected 2 edition line/);
  });

  it("ingests through runIngestion: parents per book, children with grade metadata, aligned pairs", async () => {
    const store = createMemoryRagStore();
    const result = await ingestFixture(store);

    // One parent: Abu Dawud book 1 (all 7 slice hadith live there).
    expect(result.parentIds).toHaveLength(1);
    const parent = store.allParents().find((p) => p.sourceKey === hadithSourceKey("abudawud", 1));
    expect(parent?.title).toBe("Abu Dawud — Purification (Kitab Al-Taharah)");
    expect((parent?.metadata as Record<string, unknown>).sourceType).toBe("hadith");
    expect(store.allChildren()).toHaveLength(7);

    // Both embedding tracks written for every child; the empty-secondary
    // hadiths (3, 5) keep textId null — never fabricated — while their
    // primary track is embedded normally.
    for (const child of store.allChildren()) {
      expect(child.embeddingPrimary).not.toBeNull();
      expect(child.textAr.trim().length).toBeGreaterThan(0);
      if (child.textId === null) {
        expect(child.textId).toBeNull();
      } else {
        expect(child.embeddingFallback).not.toBeNull();
      }
    }

    // Aligned pairs — seed rows for #24 (pairs only where both tracks exist (5 of 7: hadiths 3 & 5 have empty ID text)).
    expect(store.allPairs()).toHaveLength(5);
    const pair = store.allPairs().find((p) => p.pairKey === "hadith-pair:abudawud:1");
    // Substring taken verbatim from the fixture (Arabic diacritics must be
    // byte-exact, so the assertion string is derived, not hand-typed).
    const araFixture = JSON.parse(
      await readFile(resolve(FIXTURES, "ara-abudawud-slice.json"), "utf8"),
    ) as { hadiths: { hadithnumber: string; text: string }[] };
    const ar1 = araFixture.hadiths.find((h) => h.hadithnumber === "1")?.text ?? "";
    expect(pair?.textPrimary).toContain(ar1.slice(3, 40));
    expect(pair?.textSecondary).toContain("Telah menceritakan kepada kami");
    expect(pair?.morphology).toEqual([]);

    // Every costed call recorded: the report's cost equals the sum of calls.
    expect(result.report.llmCalls.length).toBeGreaterThan(0);
    expect(result.report.costMicroUsd).toBe(
      result.report.llmCalls.reduce((s, c) => s + c.costMicroUsd, 0),
    );
  });

  it("attaches the consolidated grade as filterable metadata (dhaif-wins on real disagreement)", async () => {
    const store = createMemoryRagStore();
    await ingestFixture(store);
    const gradeOf = (n: string) =>
      (store
        .allChildren()
        .find((c) => (c.metadata as Record<string, unknown>).hadithNo === n)
        ?.metadata ?? {}) as Record<string, unknown>;
    // Real Abu Dawud 2: Sahih, Sahih, Sahih Lighairihi, Daif (Zubair Ali
    // Zai) → dhaif wins.
    expect(gradeOf("2").grade).toBe("dhaif");
    // Real Abu Dawud 4: all Sahih (incl. "Sahih Bukhari (142)…") → sahih.
    expect(gradeOf("4").grade).toBe("sahih");
    // Real Abu Dawud 1: Hasan Sahih + Sahih Lighairihi mix → hasan.
    expect(gradeOf("1").grade).toBe("hasan");
    // The raw per-grader array rides along for trace transparency.
    expect((gradeOf("2").grades as unknown[]).length).toBe(4);
    // Citation is formatted from stored fields, grade included.
    expect(gradeOf("4").citation).toBe("HR. Abu Dawud no. 4 (Sahih)");
  });

  it("computes parent embeddings from summaries, not full text", async () => {
    const store = createMemoryRagStore();
    await ingestFixture(store);
    const parent = store.allParents().find((p) => p.sourceKey === hadithSourceKey("abudawud", 1));
    expect((parent?.metadata as Record<string, unknown>).summary).toContain("Thaharah");
    expect((parent?.metadata as Record<string, unknown>).summaryEmbeddedFrom).toBe("summary");
  });

  it("is idempotent: re-running ingestion writes the same counts", async () => {
    const store = createMemoryRagStore();
    await ingestFixture(store);
    await ingestFixture(store);
    expect(store.allParents()).toHaveLength(1);
    expect(store.allChildren()).toHaveLength(7);
    expect(store.allPairs()).toHaveLength(5);
  });

  // -- The ADR-0013 cross-lingual smoke retrieval, hadith corpus ------------

  it("retrieves the Arabic hadith from an Indonesian meaning query (ID→AR, primary track)", async () => {
    const store = createMemoryRagStore();
    const embedder = createCrossLingualEmbedder(DICT);
    const raw = await loadFixtureBundle();
    await runIngestion(hadithSourceParser({ abudawud: 7 }), {
      archiveKey: "hadith/test-fixture",
      raw,
    }, {
      store,
      embedder,
      summarizer: hadithSectionSummarizer(deterministicSummarizer()),
    });

    // The Ibn Umar hadith (Abu Dawud 14) queried by Indonesian MEANING.
    const queryVector = embedder.vectorsFor([
      "hadits tentang Nabi hendak berhaji atau berumrah",
    ])[0]!;

    // PRIMARY track only — the Arabic evidence index (ADR-0013).
    const hits = await store.cosineSearch("primary", queryVector, 5);
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0]!;
    expect(top.child.textAr).toContain("عَنِ ابْنِ عُمَرَ");
    // Citation metadata renders as the user-facing label; the grade rides on
    // the stored fields, not the text.
    const citation = top.child.citation as { collection: string; hadithNo: string };
    expect(
      formatHadithCitation({
        collection: "abudawud",
        hadithNo: String(citation.hadithNo),
      }),
    ).toBe("HR. Abu Dawud no. 14");
    expect(top.rankDense).toBe(1);
  });
});

/** Deterministic summarizer standing in for the cheap-tier LLM in tests. */
function deterministicSummarizer() {
  return {
    modelId: "test-summarizer",
    async generate(spec: { turns: readonly { role: string; content: string }[] }) {
      void spec;
      return {
        text: "Bab Thaharah — hadits-hadits tentang bersuci sebelum shalat.",
        cost: {
          modelId: "test-summarizer",
          tokensIn: 64,
          tokensOut: 24,
          latencyMs: 3,
          costMicroUsd: 5,
        },
      };
    },
    async stream() {
      throw new Error("test summarizer does not stream");
    },
    async embed() {
      throw new Error("test summarizer does not embed");
    },
  };
}