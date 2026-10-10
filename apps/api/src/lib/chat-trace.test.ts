import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { ChatTraceFrameSchema, type Trace } from "@app/contracts";
import type { DocChildById } from "@app/infra";
import {
  chunkFetcher,
  deriveTraceFrame,
  traceChunkIds,
  traceChunkRefs,
  traceRefused,
} from "./chat-trace";

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
  detail: { intent: "ruling", confidence: 0.87 },
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

  it("a pure refusal's trace has no retrieval events, so the panel is legitimately empty", () => {
    // A PURE refusal — the canonical sentence as the whole answer. A hybrid
    // refusal (#436) carries the partial answer's retrieval refs, so its panel
    // is populated; that shape is pinned with the citations frame in
    // chat-citations.test.ts.
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

describe("traceRefused — the refusal decision's one reader (#436)", () => {
  it("reads the trace's refusal event, and only that", () => {
    const refusal: Trace["events"][number] = {
      stage: "reviewer",
      kind: "refusal",
      detail: { trigger: "generator_refusal" },
      reason: "generator emitted the canonical insufficiency refusal",
      at: 3,
    };
    expect(traceRefused(traceOf([]))).toBe(false);
    expect(traceRefused(traceOf([], [refusal]))).toBe(true);
    // A hybrid refusal is the same decision over a trace that still carries
    // the partial answer's retrieval refs — the frame's flag and the route's
    // chunking branch both read this one predicate (chat-citations.test.ts /
    // chat.test.ts pin the two consumers).
    expect(traceRefused(traceOf([{ id: "c1" }], [refusal]))).toBe(true);
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
    expect(frame.technical.intent).toBe("ruling");
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

/**
 * The routing decision on the panel (#15). The frame is derived, never
 * reconstructed: the technical layer's `routing` block is the persisted
 * `source_routing` event's typed detail, projected verbatim. The distinction
 * that matters to a reader is between "the route restricted the corpus to these
 * sources" (`sources` non-empty), "the route did not restrict it" (an EMPTY
 * list — a decision), and "this trace recorded no routing decision at all"
 * (the block absent, as on traces persisted before the event existed).
 */
describe("the routing decision in the technical layer", () => {
  const routingEvent = (sources: string[], filters: Record<string, string[]>) =>
    ({
      stage: "router" as const,
      kind: "source_routing" as const,
      detail: { sources, filters },
      at: 2,
    }) satisfies Trace["events"][number];

  it("projects the source selection and the filter record verbatim", () => {
    const frame = deriveTraceFrame({
      trace: traceOf(
        [{ id: "c1" }],
        [routingEvent(["src_a", "src_b"], { dim_a: ["v1"], dim_b: ["v2", "v3"] })],
      ),
      messageId: "m1",
      chunksById: new Map<string, DocChildById>(),
    });
    expect(frame.technical.routing).toEqual({
      sources: ["src_a", "src_b"],
      filters: { dim_a: ["v1"], dim_b: ["v2", "v3"] },
    });
    expect(() => v.parse(ChatTraceFrameSchema, frame)).not.toThrow();
  });

  it("keeps an empty source list as the route's own statement, not as absence", () => {
    const frame = deriveTraceFrame({
      trace: traceOf([{ id: "c1" }], [routingEvent([], {})]),
      messageId: "m1",
      chunksById: new Map<string, DocChildById>(),
    });
    expect(frame.technical.routing).toEqual({ sources: [], filters: {} });
  });

  it("omits the block entirely when the trace recorded no routing decision", () => {
    // Absent is not the same claim as empty: an older trace must not be read as
    // "the corpus was not restricted".
    const frame = deriveTraceFrame({
      trace: traceOf([{ id: "c1" }]),
      messageId: "m1",
      chunksById: new Map<string, DocChildById>(),
    });
    expect(frame.technical).not.toHaveProperty("routing");
    expect(() => v.parse(ChatTraceFrameSchema, frame)).not.toThrow();
  });

  it("names the filters the run GAVE UP, from the retriever's own events", () => {
    // `filters` is the route's DECISION; a relaxed run ran without some of it, so
    // without these the panel would show a `principleTags` hint for the Principle
    // Index that does not exist yet (#16) as a filter that ran. A probe that
    // changed nothing (`adopted: false`) is machinery, not a relaxation; an
    // absent `adopted` is a trace persisted before probing, where every recorded
    // drop was applied.
    const relaxedEvent = (adopted: boolean | undefined, dropped: Record<string, string[]>) =>
      ({
        stage: "retriever" as const,
        kind: "filter_relaxed" as const,
        detail: {
          dropped,
          retained: { dim_a: ["v1"] },
          track: "primary",
          hits: adopted === false ? 0 : 3,
          ...(adopted !== undefined ? { adopted } : {}),
        },
        at: 3,
      }) satisfies Trace["events"][number];
    const frame = deriveTraceFrame({
      trace: traceOf(
        [{ id: "c1" }],
        [
          routingEvent(["src_a"], { dim_a: ["v1"], dim_c: ["v4"], dim_d: ["v5"] }),
          relaxedEvent(false, { dim_c: ["v4"] }),
          relaxedEvent(true, { dim_c: ["v4"] }),
          relaxedEvent(undefined, { dim_d: ["v5"] }),
        ],
      ),
      messageId: "m1",
      chunksById: new Map<string, DocChildById>(),
    });
    expect(frame.technical.routing?.relaxed).toEqual([
      { key: "dim_c", values: ["v4"] },
      { key: "dim_d", values: ["v5"] },
    ]);
    expect(() => v.parse(ChatTraceFrameSchema, frame)).not.toThrow();
  });

  it("carries no `relaxed` list when the run gave nothing up", () => {
    // Absent, not empty: a run that relaxed nothing must not read as one whose
    // drops were recorded as an empty list.
    const frame = deriveTraceFrame({
      trace: traceOf([{ id: "c1" }], [routingEvent(["src_a"], { dim_a: ["v1"] })]),
      messageId: "m1",
      chunksById: new Map<string, DocChildById>(),
    });
    expect(frame.technical.routing).toEqual({ sources: ["src_a"], filters: { dim_a: ["v1"] } });
  });
});
