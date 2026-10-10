import { describe, expect, it, vi } from "vitest";
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
 * The invariant under test (#11, ADR-0040): **a citation may never reach the
 * UI without a matching chunk in the persisted answer trace.** Proven in both
 * directions — emitted ⊆ cited-and-grounded (no fabricated chip, the silent
 * trust failure) and grounded-and-cited ⊆ emitted (no lost citation) — by
 * table tests on the adversarial shapes and a fast-check property over
 * randomized cite/fabricate compositions.
 *
 * **The two frame fields are independent projections of ONE persisted trace
 * (#436).** `refusal` reports the refusal decision the reviewer stage recorded
 * — the `refusal` event with its trigger stays on the trace whatever the
 * answer looked like (ADR-0007) — while the citation list is ONLY EVER the
 * cited-and-grounded intersection. A `refusal` event alone must never be read
 * as "there are no citations": the staging shape (trace `fff2a012`, merge
 * `4ea8acb8`) was a HYBRID draft, a partial answer quoting eight grounded
 * verses and then continuing into the canonical insufficiency sentence and
 * the disclaimer, and the old shortcut emptied the frame of a text whose
 * verses the user could read. It was silent because the frame stayed
 * contract-valid, no warning fired, and the live SSE and rehydration
 * derivations agreed with each other on the same wrong answer; only the
 * frame-versus-text comparison exposed it.
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

/** The retrieval-side view of a display row, for the gate the frame must agree with. */
const asChunk = (row: DocChildById): Chunk => ({
  id: row.id,
  text: row.textAr,
  metadata: row.metadata,
});

/**
 * The staging shape of #436 (trace `fff2a012`, merge `4ea8acb8`): a HYBRID
 * draft. It answers from the retrieved verses and, where the evidence ran
 * out, continues into the canonical insufficiency sentence plus the
 * disclaimer — one text that is both a grounded partial answer and a
 * generator-emitted refusal. The trace records `refusal` with
 * `trigger: "generator_refusal"` and the reviewer returns the draft unchanged,
 * so this is the text that ships and this is the text the frame is derived
 * from.
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
/** The QA trace's 27 retrieved Quran chunks; the first eight ground the cites. */
const HYBRID_TRACE_IDS = Array.from({ length: 27 }, (_, i) => `c${i}`);
const hybridChunks = (): DocChildById[] => HYBRID_SPANS.map((label, i) => chunk(`c${i}`, label));

/** The reviewer's `generator_refusal` decision, as the stage records it. */
const GENERATOR_REFUSAL: Trace["events"][number] = {
  stage: "reviewer",
  kind: "refusal",
  detail: { trigger: "generator_refusal" },
  reason: "generator emitted the canonical insufficiency refusal",
  at: 3,
};

/** The frame a pure refusal has always produced (the unchanged good case). */
const PURE_REFUSAL_FRAME = {
  messageId: "m1",
  citations: [],
  refusal: true,
  dhaifWarning: false,
};

describe("deriveCitationsFrame — a grounded range gets its chip (#274 A1)", () => {
  it("emits the range the gate accepts, with the range as written as its label", () => {
    // The reviewer's reproduction, at head before this fix: with `QS. 3:1` and
    // `QS. 3:2` retrieved the gate returned `{grounded: ["QS. 3:1"],
    // ungrounded: []}` for the real failing label `QS. 3:1-2`, while the frame
    // — matching each span against the chunk's EXACT label — emitted
    // `citations: []`. The user saw the range in prose with no source chip for
    // an answer the server's own gate had just grounded.
    const answer = "Dalilnya QS. 3:1-2 tentang hal ini.";
    const chunks = [chunk("c1", "QS. 3:1"), chunk("c2", "QS. 3:2")];
    expect(validateCitations(answer, chunks.map(asChunk))).toEqual({
      grounded: ["QS. 3:1", "QS. 3:2"],
      ungrounded: [],
    });
    const frame = frameOf(traceWithChunks(["c1", "c2"]), answer, chunks);
    // The display form is the range as written (ADR-0049 Decision 4), backed by
    // the head address's display row.
    expect(frame.citations.map((c) => c.label)).toEqual(["QS. 3:1-2"]);
    expect(frame.citations[0]).toMatchObject({ arabic: "النص العربي", source: "Sumber Tampilan" });
    // Control: the same two chunks with a plain citation emit the plain label,
    // so the new row is the range, not a changed ordinary path.
    expect(
      frameOf(
        traceWithChunks(["c1", "c2"]),
        "Dalilnya QS. 3:1 tentang hal ini.",
        chunks,
      ).citations.map((c) => c.label),
    ).toEqual(["QS. 3:1"]);
  });

  it("still emits nothing for a range the gate refuses — the other direction", () => {
    // Only `QS. 3:2` retrieved: the gate refuses the range, so the frame must
    // not invent a chip for it (ADR-0040's invariant, unchanged). Note the
    // provenance list is empty too: `QS. 3:2` is not a literal substring of
    // the written `QS. 3:1-2`, and a refused citation contributes none of the
    // addresses it names — the provenance the answer earns is what it can
    // actually back.
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
    // The QA reproduction, in one assertion: the text quotes eight grounded
    // verses AND carries the canonical refusal sentence (the reviewer's
    // `generator_refusal` decision is on the trace, and it stays there). The
    // frame must show the intersection the reader can verify, never the empty
    // refusal frame the old `refusal`-event shortcut produced.
    const frame = frameOf(
      traceWithChunks(HYBRID_TRACE_IDS, [GENERATOR_REFUSAL]),
      HYBRID_ANSWER,
      hybridChunks(),
    );
    expect(frame.citations.map((c) => c.label)).toEqual(HYBRID_SPANS);
    expect(frame).not.toEqual(PURE_REFUSAL_FRAME);
    // The refusal stays a separate projection: the decision the reviewer
    // recorded is on the wire exactly as the trace persists it. No surface
    // renders that flag today — the card draws its chips from `citations` and
    // its warning from `dhaifWarning` — so it is auditability on the trace and
    // the wire, not machinery the reader can see, and a hybrid is presented as
    // the cited answer it is.
    expect(frame.refusal).toBe(true);
  });

  it("the refusal decision never touches the citation list (#436)", () => {
    // The invariant at its true scope: the same text over the same chunks,
    // derived from a trace with and without the refusal decision, yields the
    // SAME citation list. That is what "a `refusal` event alone must never be
    // read as 'there are no citations'" means, and it holds for every refusal
    // trigger, not only `generator_refusal` (the property below randomizes the
    // hybrid composition; this is the named QA shape).
    const refused = frameOf(
      traceWithChunks(HYBRID_TRACE_IDS, [GENERATOR_REFUSAL]),
      HYBRID_ANSWER,
      hybridChunks(),
    );
    const plain = frameOf(traceWithChunks(HYBRID_TRACE_IDS), HYBRID_ANSWER, hybridChunks());
    expect(refused.citations).toEqual(plain.citations);
    expect(refused.citations.map((c) => c.label)).toEqual(HYBRID_SPANS);
    // ... and the decision itself is still projected, separately from the list.
    expect(refused.refusal).toBe(true);
    expect(plain.refusal).toBe(false);
  });

  it("the base→head delta is `citations` + `dhaifWarning`, with `refusal` constant (#436)", () => {
    // The whole delta, asserted against an EXECUTABLE model of the retired
    // `4ea8acb8` shortcut rather than described in prose. That branch froze TWO
    // fields on any refusal-bearing trace — `citations: []` and
    // `dhaifWarning: false` — and did NOT move `refusal` (which was `true`
    // before the change and after it). This is the assertion an identity that
    // holds the answer text fixed structurally cannot make, so the hybrid text
    // is driven through both semantics here.
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
    // The base revision, byte for byte: both frozen fields, flag already true.
    expect(base).toEqual({ messageId: "m1", citations: [], refusal: true, dhaifWarning: false });
    expect(head.citations.map((c) => c.label)).toEqual(["HR. Malik no. 18"]);
    expect(head.refusal).toBe(true);
    // The delta, enumerated: exactly the two un-frozen fields.
    const changed = Object.keys(head).filter(
      (key) => head[key as keyof typeof head] !== base[key as keyof typeof base],
    );
    expect(changed).toEqual(["citations", "dhaifWarning"]);
    expect(head.dhaifWarning).toBe(true);
  });

  it("a pure refusal still yields the empty-citations refusal frame it always did (#436 control)", () => {
    // The unchanged good case: the canonical refusal sentence carries no
    // citation span, so the intersection is empty BY CONSTRUCTION — the frame
    // is byte-for-byte what the shortcut used to return, in both languages,
    // even with 27 chunks retrieved. Nothing here needed the shortcut; only
    // the hybrid shape did, and there it was the defect.
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
    // Removing the shortcut widens one more field: `dhaifWarning` is now the
    // postprocess's own predicate on the delivered text for a refusal-bearing
    // trace as well (it was hard-coded false). A text that carries the warning
    // says so; the frame and the answer cannot disagree.
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
    // The frame's flag is an observable, not the control: an answer that only
    // names the grade — the "(Dhaif)" chip text or the model's own note — has
    // no warning to report, and reporting one would hide a missing rule.
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
    // One owner for "the warning is present": the rule that appends it and the
    // frame that reports it run the SAME predicate. The failing shape that
    // motivated #278 — a dhaif-graded chunk in the assembled context and a
    // draft that mentions the grade — now gains the canonical line, and the
    // frame says so.
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
    // The panel keeps the chunk row as an id — a lost title, not a made-up
    // one. The ref's own score (trace data, not store data) still rides along.
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
    // The panel is independent of the refusal (thermo-review A2): the sources
    // consulted before the refusal stay visible, so the shared read happens.
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
 * The rehydration half of #436: the issue reports the SAME empty frame coming
 * back from `GET /v1/chat/sessions/:id/messages`. The two entries share one
 * derivation, so a reload of a hybrid answer must show exactly the citations
 * the live stream showed — derived from the message's own persisted trace,
 * never from the text and never re-emptied by the refusal it also records.
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

  /**
   * #436, as a property over randomized HYBRID drafts: a grounded partial
   * answer that runs into a refusal tail. For every composition of grounded
   * spans, fabricated spans, and a refusal/disclaimer tail, the frame derived
   * from a trace that records the refusal has an **identical citation list**
   * and an identical warning flag — the decision moves the `refusal` flag and
   * nothing else — so no refusal decision, from any trigger, can ever drop a
   * grounded citation. (The same removal also un-froze `dhaifWarning`; because
   * this property holds the text fixed, that field is the same predicate on the
   * same text in both frames, and the base-delta test above is where the second
   * un-frozen field is asserted.) Before the fix this property failed on every
   * case where the tail was present: the frame came back with an empty list.
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
