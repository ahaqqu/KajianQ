import { describe, expect, it, vi } from "vite-plus/test";
import fc from "fast-check";
import type { Trace } from "@app/contracts";
import type { ChatMessage, DocChildById } from "@app/infra";
import type { Chunk } from "@app/rag-core";
import {
  DEFAULT_REFUSALS,
  MACHINE_TRANSLATION_LABEL,
  applyProductRules,
  hasWeakWarning,
  normalizeCitationLabel,
  renderEvidenceChunk,
  runStoreEffect,
  validateCitations,
} from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import { routedQuery } from "@app/kajianq-domain/test-utils/routed-query";
import { chunkFetcher, traceChunkIds } from "./chat-trace";
import { answerFramesFor, deriveCitationsFrame, rehydrateTranscript } from "./chat-citations";

/**
 * The invariant under test: **a citation may never reach the UI without a matching
 * chunk in the persisted answer trace.** Proven in both directions — emitted ⊆
 * cited-and-grounded (no fabricated chip, the silent trust failure) and
 * grounded-and-cited ⊆ emitted (no lost citation) — by table tests on the adversarial
 * shapes and a fast-check property over randomized cite/fabricate compositions.
 *
 * **The two frame fields are independent projections of ONE persisted trace.**
 * `refusal` reports the decision the reviewer stage recorded, while the citation list
 * is ONLY EVER the cited-and-grounded intersection: a `refusal` event alone must never
 * be read as "there are no citations".
 */

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

/** The retrieval-side view of a display row, for the gate the frame must agree with. */
const asChunk = (row: DocChildById): Chunk => ({
  id: row.id,
  text: row.textAr,
  metadata: row.metadata,
});

/**
 * The hybrid shape: one text that answers from the retrieved verses and, where the
 * evidence ran out, continues into the canonical insufficiency sentence plus the
 * disclaimer — both a grounded partial answer and a generator-emitted refusal. The
 * trace records `refusal` with `trigger: "generator_refusal"` and the reviewer returns
 * the draft unchanged, so this is the text that ships.
 */
const HYBRID_SPANS = [
  "QS. 1:1",
  "QS. 1:2",
  "QS. 1:3",
  "QS. 1:4",
  "QS. 1:5",
  "QS. 1:6",
  "QS. 1:7",
  "QS. 15:87",
];
const HYBRID_ANSWER =
  "Al-Fatihah menegaskan tauhid dan permohonan petunjuk: " +
  HYBRID_SPANS.slice(0, 7)
    .map((label) => `[${label}]`)
    .join(", ") +
  `. Keutamaan membacanya disebut dalam [${HYBRID_SPANS[7]}].\n\n` +
  `Untuk bagian lain dari pertanyaan ini saya ${DEFAULT_REFUSALS.id}.\n\n` +
  "Jawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.";
/** Retrieved Quran chunks; the first eight ground the cites. */
const HYBRID_TRACE_IDS = Array.from({ length: 27 }, (_, i) => `c${i}`);
const hybridChunks = (): DocChildById[] => HYBRID_SPANS.map((label, i) => chunk(`c${i}`, label));

const GENERATOR_REFUSAL: Trace["events"][number] = {
  stage: "reviewer",
  kind: "refusal",
  detail: { trigger: "generator_refusal" },
  reason: "generator emitted the canonical insufficiency refusal",
  at: 3,
};

/** The frame a pure refusal produces: the unchanged good case. */
const PURE_REFUSAL_FRAME = {
  messageId: "m1",
  citations: [],
  refusal: true,
  dhaifWarning: false,
};

describe("deriveCitationsFrame — a grounded range gets its chip (#274 A1)", () => {
  it("emits the range the gate accepts, with the range as written as its label", () => {
    // With `QS. 3:1` and `QS. 3:2` retrieved the gate grounds the range, so the frame
    // must emit a chip for it: matching each span against the chunk's EXACT label
    // alone would drop it.
    const answer = "Dalilnya QS. 3:1-2 tentang hal ini.";
    const chunks = [chunk("c1", "QS. 3:1"), chunk("c2", "QS. 3:2")];
    expect(validateCitations(answer, chunks.map(asChunk))).toEqual({
      grounded: ["QS. 3:1", "QS. 3:2"],
      ungrounded: [],
    });
    const frame = frameOf(traceWithChunks(["c1", "c2"]), answer, chunks);
    // The display form is the range as written, backed by the head address's display row.
    expect(frame.citations.map((c) => c.label)).toEqual(["QS. 3:1-2"]);
    expect(frame.citations[0]).toMatchObject({ arabic: "النص العربي", source: "Sumber Tampilan" });
    // Control: the same two chunks with a plain citation emit the plain label.
    expect(
      frameOf(
        traceWithChunks(["c1", "c2"]),
        "Dalilnya QS. 3:1 tentang hal ini.",
        chunks,
      ).citations.map((c) => c.label),
    ).toEqual(["QS. 3:1"]);
  });

  it("emits the chip for a range of ONE address the gate grounds (#444)", () => {
    // A range of one address written over that retrieved address: the label is the span
    // as written, backed by the address's display row, and only a test asserting BOTH
    // halves sees the pair of outcomes.
    const answer = "Dalilnya QS. 1:1–1 tentang hal ini.";
    const chunks = [chunk("c1", "QS. 1:1")];
    expect(validateCitations(answer, chunks.map(asChunk))).toEqual({
      grounded: ["QS. 1:1"],
      ungrounded: [],
    });
    const frame = frameOf(traceWithChunks(["c1"]), answer, chunks);
    expect(frame.citations.map((c) => c.label)).toEqual(["QS. 1:1–1"]);
    expect(frame.citations[0]).toMatchObject({ arabic: "النص العربي", source: "Sumber Tampilan" });
    // The other direction: with only a sibling verse retrieved the gate refuses the
    // span, naming it as written, and the frame invents no chip.
    const sibling = [chunk("c2", "QS. 1:2")];
    expect(validateCitations(answer, sibling.map(asChunk))).toEqual({
      grounded: [],
      ungrounded: ["QS. 1:1–1"],
    });
    expect(frameOf(traceWithChunks(["c2"]), answer, sibling).citations).toEqual([]);
  });

  it("still emits nothing for a range the gate refuses — the other direction", () => {
    // Only `QS. 3:2` retrieved: the gate refuses the range, so the frame invents no chip.
    const answer = "Dalilnya QS. 3:1-2 tentang hal ini.";
    const chunks = [chunk("c2", "QS. 3:2")];
    expect(validateCitations(answer, chunks.map(asChunk))).toEqual({
      grounded: [],
      ungrounded: ["QS. 3:1-2"],
    });
    expect(frameOf(traceWithChunks(["c2"]), answer, chunks).citations).toEqual([]);
  });

  it("follows the gate into the range's interior (the #274 A2 rule)", () => {
    const answer = "Dalilnya QS. 2:255-257 tentang hal ini.";
    const partial = [chunk("c255", "QS. 2:255"), chunk("c257", "QS. 2:257")];
    expect(validateCitations(answer, partial.map(asChunk)).ungrounded).toEqual(["QS. 2:255-257"]);
    expect(frameOf(traceWithChunks(["c255", "c257"]), answer, partial).citations).toEqual([]);
    const full = [255, 256, 257].map((n) => chunk(`c${n}`, `QS. 2:${n}`));
    expect(validateCitations(answer, full.map(asChunk)).ungrounded).toEqual([]);
    expect(
      frameOf(traceWithChunks(full.map((c) => c.id)), answer, full).citations.map((c) => c.label),
    ).toEqual(["QS. 2:255-257"]);
  });
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

  it("keeps the span's comparison form in the chip, not the draft's casing", () => {
    // The chip label is the **span's comparison form** — the normalized draft span
    // `deriveCitationsFrame` pushes — and the chunk supplies only the display row. For
    // a citation the fold rewrites, that form is the canonical spelling the chunk
    // carries, which is why the draft's casing never reaches the UI. A declared
    // address list is where the two part visibly: a grounded range's chip reads the
    // range as written while the grounding decision returns one label per address,
    // pinned by the range test above; a chunk label that is not already canonical is
    // the other half, pinned by the grade-suffix test below.
    for (const [span, label] of [
      ["HR. Bukhari No. 5010", "HR. Bukhari no. 5010"],
      ["hr. bukhari no. 5010", "HR. Bukhari no. 5010"],
      ["HR. BUKHARI NO. 5010:1", "HR. Bukhari no. 5010"],
      ["Qs. 2:255", "QS. 2:255"],
      ["jilid 1, hal. 102", "Jilid 1, Hal. 102"],
    ] as const) {
      const frame = frameOf(traceWithChunks(["c1"]), `Dalilnya [${span}].`, [chunk("c1", label)]);
      expect(frame.refusal, span).toBe(false);
      expect(
        frame.citations.map((c) => c.label),
        span,
      ).toEqual([label]);
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

  it("a hybrid draft keeps its citations and is not framed as the pure refusal (#436)", () => {
    // The text quotes grounded verses AND carries the canonical refusal sentence: the
    // frame shows the intersection the reader can verify.
    const frame = frameOf(
      traceWithChunks(HYBRID_TRACE_IDS, [GENERATOR_REFUSAL]),
      HYBRID_ANSWER,
      hybridChunks(),
    );
    expect(frame.citations.map((c) => c.label)).toEqual(HYBRID_SPANS);
    expect(frame).not.toEqual(PURE_REFUSAL_FRAME);
    // The refusal stays a separate projection: the decision the reviewer recorded is on
    // the wire exactly as the trace persists it — auditability, not reader-visible machinery.
    expect(frame.refusal).toBe(true);
  });

  it("the refusal decision never touches the citation list (#436)", () => {
    // The invariant at its true scope: the same text over the same chunks, derived from
    // a trace with and without the refusal decision, yields the SAME citation list.
    const refused = frameOf(
      traceWithChunks(HYBRID_TRACE_IDS, [GENERATOR_REFUSAL]),
      HYBRID_ANSWER,
      hybridChunks(),
    );
    const plain = frameOf(traceWithChunks(HYBRID_TRACE_IDS), HYBRID_ANSWER, hybridChunks());
    expect(refused.citations).toEqual(plain.citations);
    expect(refused.citations.map((c) => c.label)).toEqual(HYBRID_SPANS);
    expect(refused.refusal).toBe(true);
    expect(plain.refusal).toBe(false);
  });

  it("the base→head delta is `citations` + `dhaifWarning`, with `refusal` constant (#436)", () => {
    // The refusal decision must move exactly `citations` and `dhaifWarning`, with
    // `refusal` constant — asserted field by field against a baseline.
    type FrameInput = Parameters<typeof deriveCitationsFrame>[0];
    const baseFrameOf = (input: FrameInput) =>
      input.trace.events.some((event) => event.kind === "refusal")
        ? { messageId: input.messageId, citations: [], refusal: true, dhaifWarning: false }
        : deriveCitationsFrame(input);

    const warningText =
      "Hadits tersebut diriwayatkan [HR. Malik no. 18].\n\n" +
      "[Peringatan] Hadits yang dikutip berderajat lemah (dhaif); tidak dapat dijadikan dalil utama.";
    const rows = [
      chunk("h1", "HR. Malik no. 18", {
        metadata: { citation: "HR. Malik no. 18", grade: "dhaif" },
      }),
    ];
    const input = {
      trace: traceWithChunks(["h1"], [GENERATOR_REFUSAL]),
      messageId: "m1",
      answerText: warningText,
      chunksById: new Map(rows.map((row) => [row.id, row])),
    };
    const head = deriveCitationsFrame(input);
    const base = baseFrameOf(input);
    // The baseline, byte for byte: both frozen fields, flag already true.
    expect(base).toEqual({ messageId: "m1", citations: [], refusal: true, dhaifWarning: false });
    expect(head.citations.map((c) => c.label)).toEqual(["HR. Malik no. 18"]);
    expect(head.refusal).toBe(true);
    // The delta, enumerated: exactly the two fields.
    const changed = Object.keys(head).filter(
      (key) => head[key as keyof typeof head] !== base[key as keyof typeof base],
    );
    expect(changed).toEqual(["citations", "dhaifWarning"]);
    expect(head.dhaifWarning).toBe(true);
  });

  it("a pure refusal still yields the empty-citations refusal frame it always did (#436 control)", () => {
    // The pure refusal: the canonical refusal sentence carries no citation span, so the
    // intersection is empty BY CONSTRUCTION, in both languages.
    for (const refusalText of [DEFAULT_REFUSALS.id, DEFAULT_REFUSALS.en]) {
      expect(
        frameOf(
          traceWithChunks(HYBRID_TRACE_IDS, [GENERATOR_REFUSAL]),
          refusalText,
          hybridChunks(),
        ),
      ).toEqual(PURE_REFUSAL_FRAME);
    }
  });

  it("a hybrid draft that carries the warning line reports it (the shortcut froze this flag too)", () => {
    // `dhaifWarning` is the postprocess's own predicate on the delivered text,
    // refusal-bearing trace or not: the frame cannot disagree with the answer.
    const text =
      "Hadits tersebut diriwayatkan [HR. Malik no. 18].\n\n" +
      "[Peringatan] Hadits yang dikutip berderajat lemah (dhaif); tidak dapat dijadikan dalil utama.";
    const frame = frameOf(traceWithChunks(["h1"], [GENERATOR_REFUSAL]), text, [
      chunk("h1", "HR. Malik no. 18", {
        metadata: { citation: "HR. Malik no. 18", grade: "dhaif" },
      }),
    ]);
    expect(frame.citations.map((c) => c.label)).toEqual(["HR. Malik no. 18"]);
    expect(frame.dhaifWarning).toBe(true);
    expect(frame.refusal).toBe(true);
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

  it("does not read a grade mention as the warning (#278)", () => {
    // The frame's flag is an observable, not the control: a grade mention is no warning.
    for (const text of [
      "Hadits ini [HR. Tirmidhi no. 2878 (Dhaif)].",
      "Catatan: hadits ini berlabel Dhaif.",
      "The hadith is graded weak (dhaif).",
    ]) {
      expect(frameOf(traceWithChunks(["c1"]), text, [chunk("c1", "QS. 2:255")]).dhaifWarning).toBe(
        false,
      );
    }
  });

  it("reads the postprocess's own predicate, so the flag cannot contradict the answer (#278)", () => {
    // One owner for "the warning is present": the rule that appends it and the frame
    // that reports it run the SAME predicate.
    const { draft, applied } = applyProductRules(
      { text: "Hadits ini [HR. Tirmidhi no. 2878 (Dhaif)]." },
      {
        query: routedQuery("q"),
        chunks: [
          {
            id: "c1",
            text: "النص العربي",
            metadata: { grade: "dhaif", citation: "HR. Tirmidhi no. 2878 (Dhaif)" },
          },
        ],
        turns: [{ role: "user", content: "evidence" }],
      } as never,
      "id",
    );
    expect(applied).toContain("dhaif_warning");
    expect(hasWeakWarning(draft.text)).toBe(true);
    expect(
      frameOf(traceWithChunks(["c1"]), draft.text, [chunk("c1", "HR. Tirmidhi no. 2878 (Dhaif)")])
        .dhaifWarning,
    ).toBe(true);
  });
});

describe("answerFramesFor — the live route's entry (one shared store read, thermo-review B1)", () => {
  it("resolves display rows ONCE for both frames", async () => {
    const fetchChunks = vi.fn(async (ids: readonly string[]) =>
      ids.map((id) => chunk(id, "QS. 2:255")),
    );
    const { citations, trace } = await answerFramesFor({
      trace: traceWithChunks(["c1", "c2"]),
      messageId: "m1",
      answerText: "Ayat [QS. 2:255].",
      fetchChunks,
      warn: vi.fn(),
    });
    expect(fetchChunks).toHaveBeenCalledTimes(1);
    expect(fetchChunks).toHaveBeenCalledWith(["c1", "c2"]);
    expect(citations.citations).toHaveLength(1);
    expect(trace.sources.map((s) => s.id)).toEqual(["c1", "c2"]);
  });

  it("degrades BOTH frames honestly (never fabricated) when the store read fails", async () => {
    const warn = vi.fn();
    const { citations, trace } = await answerFramesFor({
      trace: traceWithChunks(["c1"]),
      messageId: "m1",
      answerText: "Ayat [QS. 2:255].",
      fetchChunks: async () => {
        throw new Error("store down");
      },
      warn,
    });
    expect(citations.citations).toEqual([]);
    expect(citations.refusal).toBe(false);
    // The panel keeps the chunk row as an id — a lost title, not a made-up one.
    expect(trace.sources).toEqual([{ id: "c1" }]);
    expect(trace.technical.chunks).toEqual([{ id: "c1", score: 0.1 }]);
    expect(warn).toHaveBeenCalledWith("chat.answer.chunk_lookup_failed", expect.anything());
  });

  it("a hybrid refusal reaches the wire with its chips, and the panel stays independent (#436)", async () => {
    const fetchChunks = vi.fn(async () => hybridChunks());
    const { citations, trace: traceFrame } = await answerFramesFor({
      trace: traceWithChunks(HYBRID_TRACE_IDS, [GENERATOR_REFUSAL]),
      messageId: "m1",
      answerText: HYBRID_ANSWER,
      fetchChunks,
      warn: vi.fn(),
    });
    expect(citations.refusal).toBe(true);
    expect(citations.citations.map((c) => c.label)).toEqual(HYBRID_SPANS);
    // The panel is independent of the refusal: the sources consulted stay visible.
    expect(fetchChunks).toHaveBeenCalledTimes(1);
    expect(traceFrame.sources.map((s) => s.id)).toEqual(HYBRID_TRACE_IDS);
  });

  it("a trace with no retrieval events needs no store read at all", async () => {
    const fetchChunks = vi.fn();
    const { citations, trace } = await answerFramesFor({
      trace: { id: "t1", createdAt: 1, events: [] },
      messageId: "m1",
      answerText: "teks",
      fetchChunks,
      warn: vi.fn(),
    });
    expect(fetchChunks).not.toHaveBeenCalled();
    expect(citations.citations).toEqual([]);
    expect(trace.sources).toEqual([]);
  });

  it("parses both emitted frames against their contracts", async () => {
    const { citations, trace } = await answerFramesFor({
      trace: traceWithChunks(["c1"]),
      messageId: "m1",
      answerText: "Ayat [QS. 2:255].",
      fetchChunks: async (ids) => ids.map((id) => chunk(id, "QS. 2:255")),
      warn: vi.fn(),
    });
    expect(citations.citations).toHaveLength(1);
    expect(trace.messageId).toBe("m1");
  });

  it("chunkFetcher bridges the store seam through the typed StoreBridge", async () => {
    // The real memory store and the real domain bridge run the seam end-to-end.
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
    // The same logical chunk as the assembler's renderer and the citation derive see it.
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
 * The rehydration entry shares one derivation with the live route, so a reload of a
 * hybrid answer must show exactly the citations the live stream showed.
 */
describe("rehydrateTranscript — a hybrid answer rehydrates with its chips (#436)", () => {
  const hybridRow: ChatMessage = {
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    content: HYBRID_ANSWER,
    answerTraceId: "tr-1",
    createdAt: 1,
  };

  it("carries the live frame's citations for the hybrid row", async () => {
    const payload = await rehydrateTranscript({
      sessionId: "s1",
      rows: [hybridRow],
      truncated: false,
      getTrace: async () => traceWithChunks(HYBRID_TRACE_IDS, [GENERATOR_REFUSAL]),
      fetchChunks: async () => hybridChunks(),
      warn: vi.fn(),
    });
    const frame = payload.messages[0]?.citations;
    expect(frame?.refusal).toBe(true);
    expect(frame?.citations.map((c) => c.label)).toEqual(HYBRID_SPANS);
  });

  it("still omits the frame's citations for a pure refusal row", async () => {
    const payload = await rehydrateTranscript({
      sessionId: "s1",
      rows: [{ ...hybridRow, content: DEFAULT_REFUSALS.id }],
      truncated: false,
      getTrace: async () => traceWithChunks(HYBRID_TRACE_IDS, [GENERATOR_REFUSAL]),
      fetchChunks: async () => hybridChunks(),
      warn: vi.fn(),
    });
    expect(payload.messages[0]?.citations).toEqual(PURE_REFUSAL_FRAME);
  });
});

/**
 * Property proof of both invariant directions over randomized compositions: emitted
 * labels are EXACTLY the cited spans that trace-retrieved chunks ground — nothing
 * fabricated sneaks in, nothing grounded is lost.
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

  /**
   * A property over randomized HYBRID drafts: a grounded partial answer that runs into
   * a refusal tail. For every composition, the frame derived from a trace that records
   * the refusal has an **identical citation list** and warning flag — the decision moves
   * only the `refusal` flag — so no refusal can drop a grounded citation.
   */
  it("a refusal tail never drops the grounded citations of a hybrid draft (#436)", () => {
    const tailArb = fc.constantFrom(
      DEFAULT_REFUSALS.id,
      DEFAULT_REFUSALS.en,
      "[Peringatan] Hadits yang dikutip berderajat lemah (dhaif); tidak dapat dijadikan dalil utama.",
      "Jawaban ini bukan fatwa; rujuk ulama untuk keputusan hukum.",
    );
    const property = fc.property(
      fc.array(labelArb, { minLength: 1, maxLength: 4 }),
      fc.array(spanArb, { minLength: 0, maxLength: 4 }),
      fc.boolean(),
      tailArb,
      (chunkShapes, spanShapes, refused, tail) => {
        const labels = [
          ...new Set(chunkShapes.map((s) => normalizeCitationLabel(`QS. ${s.surah}:${s.ayah}`))),
        ];
        const chunks = labels.map((label, i) => chunk(`c${i}`, label));
        const ids = labels.map((_, i) => `c${i}`);
        const spans = spanShapes.map((s) => `QS. ${s.surah}:${s.ayah}`);
        const text = `${spans.join(" dan ")}.\n\n${tail}`;
        const extra: Trace["events"] = refused ? [GENERATOR_REFUSAL] : [];
        const framed = frameOf(traceWithChunks(ids, extra), text, chunks);
        const plain = frameOf(traceWithChunks(ids), text, chunks);
        expect(framed.citations).toEqual(plain.citations);
        expect(framed.dhaifWarning).toBe(plain.dhaifWarning);
        expect(framed.refusal).toBe(refused);
        expect(plain.refusal).toBe(false);
      },
    );
    expect(fc.assert(property, { numRuns: 300 })).toBeUndefined();
  });
});
