import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { ChatTraceFrameSchema, type Trace } from "@app/contracts";
import type { DocChildById } from "@app/infra";
import { chunkFetcher, deriveTraceFrame, traceChunkIds, traceChunkRefs } from "./chat-trace";

/**
 * The Trace panel frame's invariant (#12, ADR-0007): **the panel is derived
 * from the persisted trace's own typed events, never invented.** Sources are
 * the deduplicated retrieval refs in retrieval order; the technical layer
 * carries intent, sub-queries, scores, and model identities verbatim; a
 * chunk display row that fails to resolve loses its title, never gains a
 * fabricated one.
 */

/** A trace with the given retrieval refs plus extra events. */
function traceOf(
  refs: {
    id: string;
    score?: number;
    rankDense?: number;
    rankSparse?: number;
    origin?: string;
  }[],
  extra: Trace["events"] = [],
): Trace {
  return {
    id: "t1",
    createdAt: 1,
    events: [
      ...extra,
      {
        stage: "retriever" as const,
        kind: "retrieval" as const,
        detail: { chunks: refs },
        at: 5,
      },
    ],
  };
}

function chunkRow(id: string, parentTitle: string): DocChildById {
  return {
    id,
    parentId: `parent-${id}`,
    textRaw: "raw",
    textAr: "النص العربي",
    textId: null,
    citation: {},
    embeddingPrimary: null,
    embeddingFallback: null,
    ordinal: 0,
    metadata: {},
    createdAt: 0,
    parentTitle,
  };
}

const derive = (trace: Trace, rows: readonly DocChildById[]) =>
  deriveTraceFrame({ trace, messageId: "m1", chunksById: new Map(rows.map((r) => [r.id, r])) });

const INTENT = {
  stage: "router" as const,
  kind: "intent" as const,
  detail: { intent: "dalil_umum", confidence: 0.87 },
  at: 0,
};
const SUBQ = (text: string) => ({
  stage: "router" as const,
  kind: "subquery" as const,
  detail: { text },
  at: 1,
});
const CALL = (modelId: string) => ({
  stage: "generator" as const,
  kind: "llm_call" as const,
  cost: { modelId, tokensIn: 10, tokensOut: 5, latencyMs: 100, costMicroUsd: 7 },
  at: 3,
});

describe("traceChunkIds / traceChunkRefs", () => {
  it("dedup by id, first ref wins (retrieval order)", () => {
    const trace = traceOf(
      [{ id: "c1", score: 0.5 }],
      [
        {
          stage: "retriever",
          kind: "retrieval",
          detail: {
            chunks: [
              { id: "c1", score: 0.1 },
              { id: "c2", score: 0.2 },
            ],
          },
          at: 9,
        },
      ],
    );
    expect(traceChunkIds(trace)).toEqual(["c1", "c2"]);
    expect(traceChunkRefs(trace)[0]?.score).toBe(0.1); // the first ref wins
  });
});

describe("deriveTraceFrame — the top layer", () => {
  it("lists sources in retrieval order with their display titles, no scores", () => {
    const frame = derive(traceOf([{ id: "c2" }, { id: "c1" }]), [
      chunkRow("c1", "Al-Baqarah"),
      chunkRow("c2", "Al-Muwatta"),
    ]);
    expect(frame.sources).toEqual([
      { id: "c2", source: "Al-Muwatta" },
      { id: "c1", source: "Al-Baqarah" },
    ]);
  });

  it("omits the title of a chunk whose row (or title) is missing — id-only, never fabricated", () => {
    const frame = derive(traceOf([{ id: "c1" }, { id: "ghost" }]), [chunkRow("c1", "Al-Baqarah")]);
    expect(frame.sources).toEqual([{ id: "c1", source: "Al-Baqarah" }, { id: "ghost" }]);
  });

  it("a refusal's trace has no retrieval events, so the panel is legitimately empty", () => {
    const refusal: Trace = {
      id: "t2",
      createdAt: 1,
      events: [
        {
          stage: "reviewer",
          kind: "refusal",
          reason: "tidak menemukan dalil yang memadai",
          detail: { trigger: "generator_refusal" },
          at: 1,
        },
      ],
    };
    const frame = derive(refusal, []);
    expect(frame.sources).toEqual([]);
    expect(frame.technical.chunks).toEqual([]);
    expect(frame.technical.models).toEqual([]);
  });
});

describe("deriveTraceFrame — the technical layer", () => {
  it("carries intent, confidence, sub-queries, scores, and distinct model ids", () => {
    const frame = derive(
      traceOf(
        [{ id: "c1", score: 0.03125, rankDense: 1, rankSparse: 3 }],
        [
          INTENT,
          SUBQ("ayat kursi"),
          SUBQ("QS 2:255 terjemahan"),
          CALL("model-a"),
          CALL("model-b"),
          CALL("model-a"),
        ],
      ),
      [chunkRow("c1", "Al-Baqarah")],
    );
    expect(frame.technical.intent).toBe("dalil_umum");
    expect(frame.technical.confidence).toBe(0.87);
    expect(frame.technical.subQueries).toEqual(["ayat kursi", "QS 2:255 terjemahan"]);
    expect(frame.technical.chunks).toEqual([
      {
        id: "c1",
        source: "Al-Baqarah",
        score: 0.03125,
        rankDense: 1,
        rankSparse: 3,
      },
    ]);
    expect(frame.technical.models).toEqual(["model-a", "model-b"]);
  });

  it("omits intent and confidence when the trace recorded none (older traces stay readable)", () => {
    const frame = derive(traceOf([], [CALL("model-a")]), []);
    expect(frame.technical).toEqual({
      subQueries: [],
      chunks: [],
      models: ["model-a"],
    });
    expect("intent" in frame.technical).toBe(false);
  });

  it("projects a chunk ref's `origin` label into the technical layer (A1)", () => {
    // An expansion chunk has no score and no channel ranks, so this label is
    // the only thing on the frame that says why the surah's verses are here.
    const frame = derive(
      traceOf([
        { id: "c1", score: 0.5, rankDense: 1 },
        { id: "c7", origin: "scope_expansion" },
      ]),
      [chunkRow("c1", "Al-Muwatta"), chunkRow("c7", "QS. 1")],
    );
    expect(frame.technical.chunks).toEqual([
      { id: "c1", source: "Al-Muwatta", score: 0.5, rankDense: 1 },
      { id: "c7", source: "QS. 1", origin: "scope_expansion" },
    ]);
    // The top layer stays plain language: a source consulted, no machinery.
    expect(frame.sources).toEqual([
      { id: "c1", source: "Al-Muwatta" },
      { id: "c7", source: "QS. 1" },
    ]);
  });

  it("derives a pre-change frame (no `origin` anywhere) that still parses against the contract", () => {
    // The compatibility pin A1 asks for: a trace persisted before the field
    // existed renders the same frame it always did — no origin key appears,
    // and the frame the route parses is the contract's own shape.
    const frame = derive(traceOf([{ id: "c1", score: 0.5, rankDense: 1, rankSparse: 2 }]), [
      chunkRow("c1", "Al-Baqarah"),
    ]);
    expect("origin" in (frame.technical.chunks[0] ?? {})).toBe(false);
    expect("origin" in (frame.sources[0] ?? {})).toBe(false);
    const parsed = v.safeParse(ChatTraceFrameSchema, frame);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.output.technical.chunks[0]?.origin).toBeUndefined();
  });
});

describe("chunkFetcher", () => {
  it("binds the store seam through the bridge (a wrong call fails to compile)", async () => {
    const { runStoreEffect } = await import("@app/kajianq-domain");
    const { createMemoryRagStore } =
      await import("@app/kajianq-domain/test-utils/memory-rag-store");
    const store = createMemoryRagStore();
    const parentId = await runStoreEffect<string>(
      store.insertDocParent({ sourceKey: "quran/2", title: "Al-Baqarah", metadata: {} }),
    );
    const childId = await runStoreEffect<string>(
      store.insertDocChild({
        parentId,
        textRaw: "raw",
        textAr: "النص",
        textId: null,
        citation: {},
        embeddingPrimary: null,
        embeddingFallback: null,
        ordinal: 0,
        metadata: {},
      } as never),
    );
    const fetch = chunkFetcher(store, runStoreEffect);
    const rows = await fetch([childId]);
    expect(rows[0]?.parentTitle).toBe("Al-Baqarah");
  });
});
