import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { Trace } from "@app/contracts";
import type { DocChildById } from "@app/infra";
import type { Chunk } from "@app/rag-core";
import {
  MACHINE_TRANSLATION_LABEL,
  normalizeCitationLabel,
  renderEvidenceChunk,
  runStoreEffect,
} from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import {
  chunkFetcher,
  citationsFrameFor,
  deriveCitationsFrame,
  traceChunkIds,
} from "./chat-citations";

/**
 * The invariant under test (#11, ADR-0040): **a citation may never reach the
 * UI without a matching chunk in the persisted answer trace.** Proven in both
 * directions — emitted ⊆ cited-and-grounded (no fabricated chip, the silent
 * trust failure) and grounded-and-cited ⊆ emitted (no lost citation) — by
 * table tests on the adversarial shapes and a fast-check property over
 * randomized cite/fabricate compositions.
 */

/** A persisted-trace-shaped Trace with the given retrieval chunk refs. */
function traceWithChunks(ids: string[], extra: Trace["events"] = []): Trace {
  return {
    id: "t1",
    createdAt: 1,
    events: [
      ...extra,
      {
        stage: "retriever" as const,
        kind: "retrieval" as const,
        detail: { chunks: ids.map((id) => ({ id, score: 0.1 })) },
        at: 1,
      },
    ],
  };
}

/** A DocChildById display row with the given citation label in metadata. */
function chunk(id: string, label: string, overrides: Partial<DocChildById> = {}): DocChildById {
  return {
    id,
    parentId: `parent-${id}`,
    textRaw: "raw",
    textAr: "النص العربي",
    textId: "Terjemahan Indonesia.",
    citation: {},
    embeddingPrimary: null,
    embeddingFallback: null,
    ordinal: 0,
    metadata: { citation: label },
    createdAt: 0,
    parentTitle: "Sumber Tampilan",
    ...overrides,
  };
}

const frameOf = (trace: Trace, text: string, chunks: readonly DocChildById[]) =>
  deriveCitationsFrame({
    trace,
    messageId: "m1",
    answerText: text,
    chunksById: new Map(chunks.map((c) => [c.id, c])),
  });

describe("traceChunkIds", () => {
  it("extracts retrieval chunk refs in order, deduplicated, ignoring other events", () => {
    const trace = traceWithChunks(
      ["c1", "c2"],
      [
        { stage: "router", kind: "intent", detail: { intent: "i" }, at: 0 },
        {
          stage: "retriever",
          kind: "retrieval",
          detail: { chunks: [{ id: "c1" }] },
          at: 2,
        },
      ],
    );
    expect(traceChunkIds(trace)).toEqual(["c1", "c2"]);
  });

  it("returns [] for a trace with no retrieval events", () => {
    expect(traceChunkIds({ id: "t", createdAt: 1, events: [] })).toEqual([]);
  });
});

describe("deriveCitationsFrame — the invariant, adversarial shapes", () => {
  it("emits exactly the cited grounded span, resolved against the trace chunk", () => {
    const frame = frameOf(
      traceWithChunks(["c1"]),
      "Dalilnya [QS. 2:255] jelas.\n\nJawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.",
      [chunk("c1", "QS. 2:255")],
    );
    expect(frame.refusal).toBe(false);
    expect(frame.citations).toHaveLength(1);
    expect(frame.citations[0]).toMatchObject({
      label: "QS. 2:255",
      arabic: "النص العربي",
      translation: "Terjemahan Indonesia.",
      machineTranslated: true,
      source: "Sumber Tampilan",
    });
  });

  it("never emits a fabricated span that no trace chunk grounds", () => {
    const frame = frameOf(
      traceWithChunks(["c1"]),
      "Palsu: [QS. 9:99] dan [HR. Bukhari no. 99999].",
      [chunk("c1", "QS. 2:255")],
    );
    expect(frame.citations).toEqual([]);
  });

  it("emits the grounded span and drops the fabricated one in the same answer", () => {
    const frame = frameOf(
      traceWithChunks(["c1"]),
      "Benar [QS. 2:255], palsu [HR. Bukhari no. 99999].",
      [chunk("c1", "QS. 2:255")],
    );
    expect(frame.citations.map((c) => c.label)).toEqual(["QS. 2:255"]);
  });

  it("resolves marker spelling variants (Q.S. / QS) to the canonical chunk label", () => {
    for (const span of ["Q.S. 2:255", "QS 2:255"]) {
      const frame = frameOf(traceWithChunks(["c1"]), `Ayat [${span}].`, [chunk("c1", "QS. 2:255")]);
      expect(frame.citations.map((c) => c.label)).toEqual(["QS. 2:255"]);
    }
  });

  it("matches a chunk label carrying a grade suffix and surfaces the grade badge", () => {
    const frame = frameOf(traceWithChunks(["h1"]), "Diriwayatkan [HR. Malik no. 18].", [
      chunk("h1", "HR. Malik no. 18 (Sahih)", {
        metadata: { citation: "HR. Malik no. 18 (Sahih)", grade: "sahih" },
        textId: null,
        parentTitle: "Al-Muwatta",
      }),
    ]);
    expect(frame.citations).toHaveLength(1);
    expect(frame.citations[0]).toMatchObject({
      label: "HR. Malik no. 18",
      grade: "sahih",
      machineTranslated: false,
    });
    // No translation layer → the key is absent, not present-but-empty.
    expect("translation" in frame.citations[0]!).toBe(false);
  });

  it("a refused answer carries no citations even when its text has citation spans", () => {
    const trace = traceWithChunks(
      ["c1"],
      [{ stage: "reviewer", kind: "refusal", reason: "ungrounded citation", at: 3 }],
    );
    const frame = frameOf(trace, "Maaf, [QS. 2:255] tidak dapat saya pastikan.", [
      chunk("c1", "QS. 2:255"),
    ]);
    expect(frame).toEqual({
      messageId: "m1",
      citations: [],
      refusal: true,
      dhaifWarning: false,
    });
  });

  it("a trace ref whose chunk row is gone backs no citation (invariant by omission)", () => {
    const frame = frameOf(traceWithChunks(["c1", "c2"]), "Ayat [QS. 2:255] dan [QS. 112:1].", [
      chunk("c1", "QS. 2:255"),
      // c2 row missing from the lookup result.
    ]);
    expect(frame.citations.map((c) => c.label)).toEqual(["QS. 2:255"]);
  });

  it("a chunk without an Arabic original backs no citation sheet (ADR-0013)", () => {
    const frame = frameOf(traceWithChunks(["c1"]), "Ayat [QS. 2:255].", [
      chunk("c1", "QS. 2:255", { textAr: "  " }),
    ]);
    expect(frame.citations).toEqual([]);
  });

  it("duplicate spans collapse to one citation, in first-appearance order", () => {
    const frame = frameOf(
      traceWithChunks(["c1", "c2"]),
      "[QS. 112:1] lalu [QS. 2:255] lagi [QS. 112:1].",
      [chunk("c2", "QS. 2:255"), chunk("c1", "QS. 112:1")],
    );
    expect(frame.citations.map((c) => c.label)).toEqual(["QS. 112:1", "QS. 2:255"]);
  });

  it("two chunks both cited yield two citations, each resolved to its own chunk", () => {
    const frame = frameOf(traceWithChunks(["c1", "c2"]), "[QS. 2:255] dan [QS. 112:1].", [
      chunk("c1", "QS. 2:255"),
      chunk("c2", "QS. 112:1", { textId: null }),
    ]);
    expect(frame.citations.map((c) => c.label)).toEqual(["QS. 2:255", "QS. 112:1"]);
    expect(frame.citations[1]?.machineTranslated).toBe(false);
  });

  it("the dhaifWarning flag tracks the canonical warning line (ID and EN)", () => {
    const idFrame = frameOf(
      traceWithChunks(["c1"]),
      "x [Peringatan] Hadits yang dikutip berderajat lemah (dhaif); tidak dapat dijadikan dalil utama.",
      [chunk("c1", "QS. 2:255")],
    );
    expect(idFrame.dhaifWarning).toBe(true);
    const enFrame = frameOf(
      traceWithChunks(["c1"]),
      "[Warning] The cited hadith is graded weak (dhaif); it may not be used as a primary proof.",
      [chunk("c1", "QS. 2:255")],
    );
    expect(enFrame.dhaifWarning).toBe(true);
    expect(
      frameOf(traceWithChunks(["c1"]), "Jawaban biasa.", [chunk("c1", "QS. 2:255")]).dhaifWarning,
    ).toBe(false);
  });
});

describe("citationsFrameFor — the route-level wrapper", () => {
  it("degrades to an empty citation list (never a fabricated one) when the store read fails", async () => {
    const warn = vi.fn();
    const frame = await citationsFrameFor({
      trace: traceWithChunks(["c1"]),
      messageId: "m1",
      answerText: "Ayat [QS. 2:255].",
      fetchChunks: async () => {
        throw new Error("store down");
      },
      warn,
    });
    expect(frame.citations).toEqual([]);
    expect(frame.refusal).toBe(false);
    expect(warn).toHaveBeenCalledWith("chat.citations.chunk_lookup_failed", expect.anything());
  });

  it("a refused answer never touches the store", async () => {
    const fetchChunks = vi.fn(async () => [chunk("c1", "QS. 2:255")]);
    const trace = traceWithChunks(
      ["c1"],
      [{ stage: "reviewer", kind: "refusal", reason: "r", at: 3 }],
    );
    const frame = await citationsFrameFor({
      trace,
      messageId: "m1",
      answerText: "teks",
      fetchChunks,
      warn: vi.fn(),
    });
    expect(frame.refusal).toBe(true);
    expect(fetchChunks).not.toHaveBeenCalled();
  });

  it("parses the emitted frame against the contract", async () => {
    const frame = await citationsFrameFor({
      trace: traceWithChunks(["c1"]),
      messageId: "m1",
      answerText: "Ayat [QS. 2:255].",
      fetchChunks: async (ids) => ids.map((id) => chunk(id, "QS. 2:255")),
      warn: vi.fn(),
    });
    expect(frame.citations).toHaveLength(1);
  });

  it("chunkFetcher bridges the store seam through the typed StoreBridge", async () => {
    // The real memory store and the real domain bridge run the seam
    // end-to-end: the typed bridge (thermo-review B2) needs no casts, and
    // wiring a wrong store call here would not compile.
    const store = createMemoryRagStore();
    const parentId = await runStoreEffect<string>(
      store.insertDocParent({ sourceKey: "quran/test", title: "Sumber Tampilan", metadata: {} }),
    );
    const childId = await runStoreEffect<string>(
      store.insertDocChild({
        parentId,
        textRaw: "raw",
        textAr: "النص العربي",
        textId: "Terjemahan Indonesia.",
        embeddingPrimary: [1, 0, 0],
        embeddingFallback: null,
        ordinal: 0,
        metadata: { citation: "QS. 2:255" },
      }),
    );
    const fetchChunks = chunkFetcher(store, runStoreEffect);
    const rows = await fetchChunks([childId]);
    expect(rows.map((r) => r.id)).toEqual([childId]);
    expect(rows[0]).toMatchObject({ textAr: "النص العربي", parentTitle: "Sumber Tampilan" });
  });

  it("the wire flag agrees with the assembler's machine-translation label (thermo-review A3)", () => {
    // The chunk's layer values as the assembler's evidence renderer sees
    // them (both layers ride the metadata) and as the citation derive sees
    // them (textId column) — the same logical chunk.
    const bothLayers = chunk("c1", "QS. 2:255");
    const evidence: Chunk = {
      id: "c1",
      text: bothLayers.textAr,
      metadata: { citation: "QS. 2:255", textAr: bothLayers.textAr, textId: bothLayers.textId },
    };
    expect(renderEvidenceChunk(evidence)).toContain(MACHINE_TRANSLATION_LABEL);
    const frame = frameOf(traceWithChunks(["c1"]), "Ayat [QS. 2:255].", [bothLayers]);
    expect(frame.citations[0]?.machineTranslated).toBe(true);

    // Arabic original only: neither surface claims a translation at all.
    const arabicOnly = chunk("c2", "QS. 112:1", { textId: null });
    const arabicEvidence: Chunk = {
      id: "c2",
      text: arabicOnly.textAr,
      metadata: { citation: "QS. 112:1", textAr: arabicOnly.textAr },
    };
    expect(renderEvidenceChunk(arabicEvidence)).not.toContain(MACHINE_TRANSLATION_LABEL);
    const bare = frameOf(traceWithChunks(["c2"]), "Ayat [QS. 112:1].", [arabicOnly]).citations[0];
    expect("translation" in bare!).toBe(false);
    expect(bare?.machineTranslated).toBe(false);
  });
});

/**
 * Property proof of both invariant directions over randomized compositions:
 * emitted labels are EXACTLY the cited spans that trace-retrieved chunks
 * ground — nothing fabricated sneaks in, nothing grounded is lost.
 */
describe("deriveCitationsFrame — property (fast-check)", () => {
  // Canonical Quran-label chunks; spans may cite or fabricate.
  const labelArb = fc.record({
    surah: fc.integer({ min: 1, max: 114 }),
    ayah: fc.integer({ min: 1, max: 286 }),
  });
  const spanArb = fc.record({
    surah: fc.integer({ min: 1, max: 114 }),
    ayah: fc.integer({ min: 1, max: 286 }),
  });

  it("emitted == cited spans ∩ trace-chunk-grounded labels", () => {
    const property = fc.property(
      fc.array(labelArb, { minLength: 1, maxLength: 3 }),
      fc.array(spanArb, { minLength: 0, maxLength: 5 }),
      (chunkShapes, spanShapes) => {
        const labels = chunkShapes.map((s) => normalizeCitationLabel(`QS. ${s.surah}:${s.ayah}`));
        const uniqueLabels = [...new Set(labels)];
        const chunks = uniqueLabels.map((label, i) => chunk(`c${i}`, label));
        const trace = traceWithChunks(uniqueLabels.map((_, i) => `c${i}`));
        // The answer cites a random mix of chunk labels and fabricated spans.
        const spans = spanShapes.map((s) => `QS. ${s.surah}:${s.ayah}`);
        const answerText = `${spans.join(" dan ")}.`;
        const frame = frameOf(trace, answerText, chunks);

        const grounded = new Set(uniqueLabels);
        const expected: string[] = [];
        for (const span of spans) {
          const normalized = normalizeCitationLabel(span);
          if (grounded.has(normalized) && !expected.includes(normalized)) {
            expected.push(normalized);
          }
        }
        expect(frame.citations.map((c) => c.label)).toEqual(expected);
      },
    );
    expect(fc.assert(property, { numRuns: 300 })).toBeUndefined();
  });
});
