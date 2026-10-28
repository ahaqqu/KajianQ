import { describe, expect, it } from "vite-plus/test";
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

/** The frame is derived from the persisted trace's typed events, never invented: refs in
 * dedup order, verbatim scores and model ids, and no fabricated title for an unresolved row. */

function traceOf(
  refs: {
    id: string;
    score?: number;
    rankDense?: number;
    rankSparse?: number;
    rerankScore?: number;
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
    expect(traceChunkRefs(trace)[0]?.score).toBe(0.1);
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
    // A hybrid refusal is the same decision over a trace that still carries the
    // partial answer's refs; its panel is populated (chat-citations.test.ts).
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
    expect(traceRefused(traceOf([{ id: "c1" }], [refusal]))).toBe(true);
  });

  it("is true for a run's own decline, which no reviewer judged", () => {
    // A route carrying no question is declined by the runner: the delivered text
    // is product copy with no model behind it, so the frame must flag it exactly
    // as it flags a refusal — the client renders the record, it does not
    // reconstruct which stage wrote the text.
    const decline: Trace["events"][number] = {
      stage: "generator",
      kind: "refusal",
      detail: { trigger: "content_free_decline" },
      reason: "the route carries no question, so no answer is generated for it",
      at: 3,
    };
    expect(traceRefused(traceOf([], [decline]))).toBe(true);
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
    // An expansion chunk has no score or ranks, so this label is the only "why" on the frame.
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

  it("projects a chunk ref's rerankScore beside the fused score (A5)", () => {
    // The list is in reranked order, so the number that explains the order must
    // reach the panel: the fused score alone would contradict it.
    const frame = derive(
      traceOf([
        { id: "c2", score: 0.031, rerankScore: 0.71 },
        { id: "c1", score: 0.03, rerankScore: 0.08 },
      ]),
      [chunkRow("c1", "Al-Baqarah"), chunkRow("c2", "Al-Muwatta")],
    );
    expect(frame.technical.chunks).toEqual([
      { id: "c2", source: "Al-Muwatta", score: 0.031, rerankScore: 0.71 },
      { id: "c1", source: "Al-Baqarah", score: 0.03, rerankScore: 0.08 },
    ]);
    // The top layer stays plain language: no score, no rerank probability.
    expect(frame.sources.map((source) => source.id)).toEqual(["c2", "c1"]);
    expect(v.safeParse(ChatTraceFrameSchema, frame).success).toBe(true);
  });

  it("derives a pre-change frame (no `origin` anywhere) that still parses against the contract", () => {
    // A trace persisted before the field existed renders no origin key and still
    // parses against the contract.
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
 * The routing block is the persisted `source_routing` event's typed detail,
 * projected verbatim. `sources` non-empty = the route restricted the corpus to
 * those sources; an EMPTY list = it did not restrict; the block absent = the trace
 * recorded no routing decision.
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
    // Absent is not the same claim as empty: a trace with no routing event must
    // not read as "not restricted".
    const frame = deriveTraceFrame({
      trace: traceOf([{ id: "c1" }]),
      messageId: "m1",
      chunksById: new Map<string, DocChildById>(),
    });
    expect(frame.technical).not.toHaveProperty("routing");
    expect(() => v.parse(ChatTraceFrameSchema, frame)).not.toThrow();
  });

  it("names the filters the run GAVE UP, from the retriever's own events", () => {
    // `filters` is the route's DECISION; a relaxed run ran without some of it. A
    // probe that changed nothing (`adopted: false`) is machinery, not a relaxation;
    // an absent `adopted` is a trace from before probing, where every drop applied.
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
    // Absent, not empty: a run that relaxed nothing must not read as a record of
    // an empty drop list.
    const frame = deriveTraceFrame({
      trace: traceOf([{ id: "c1" }], [routingEvent(["src_a"], { dim_a: ["v1"] })]),
      messageId: "m1",
      chunksById: new Map<string, DocChildById>(),
    });
    expect(frame.technical.routing).toEqual({ sources: ["src_a"], filters: { dim_a: ["v1"] } });
  });
});

/**
 * The reviewer pre-gate's verdict is the persisted `decision` event projected,
 * never a client-side reading: a skip that cleared every citation, an escalate
 * that names its reason and leaves a citation unjudged, and — when the run never
 * entered the pre-gate — no block at all, because absence is not "cleared".
 */
describe("the reviewer pre-gate verdict in the technical layer", () => {
  const decisionEvent = (
    stage: "reviewer" | "router",
    detail: {
      purpose?: string;
      outcome: "skip" | "escalate";
      reason?: "below_threshold" | "no_items" | "malformed_answer" | "vendor_failure";
      threshold?: number;
      items: { index: number; key: string; score?: number }[];
    },
    at = 7,
  ) =>
    ({
      stage,
      kind: "decision" as const,
      detail: { purpose: "citation_support", ...detail },
      at,
    }) satisfies Trace["events"][number];

  it("projects a skip: outcome, threshold, and the per-citation scores", () => {
    const frame = deriveTraceFrame({
      trace: traceOf(
        [{ id: "c1" }],
        [
          decisionEvent("reviewer", {
            outcome: "skip",
            threshold: 0.5,
            items: [
              { index: 0, key: "QS. 2:255", score: 0.93 },
              { index: 1, key: "HR. Malik no. 18", score: 0.61 },
            ],
          }),
        ],
      ),
      messageId: "m1",
      chunksById: new Map<string, DocChildById>(),
    });
    expect(frame.technical.reviewer).toEqual({
      outcome: "skip",
      threshold: 0.5,
      items: [
        { index: 0, key: "QS. 2:255", score: 0.93 },
        { index: 1, key: "HR. Malik no. 18", score: 0.61 },
      ],
    });
    expect(() => v.parse(ChatTraceFrameSchema, frame)).not.toThrow();
  });

  it("projects an escalate with its reason and an unjudged citation left unscored", () => {
    const frame = deriveTraceFrame({
      trace: traceOf(
        [{ id: "c1" }],
        [
          decisionEvent("reviewer", {
            outcome: "escalate",
            reason: "malformed_answer",
            threshold: 0.5,
            items: [{ index: 0, key: "QS. 2:255" }],
          }),
        ],
      ),
      messageId: "m1",
      chunksById: new Map<string, DocChildById>(),
    });
    expect(frame.technical.reviewer).toEqual({
      outcome: "escalate",
      reason: "malformed_answer",
      threshold: 0.5,
      items: [{ index: 0, key: "QS. 2:255" }],
    });
    // "Not judged" is the absence of a score, never a zero.
    expect(frame.technical.reviewer?.items[0]?.score).toBeUndefined();
    expect(() => v.parse(ChatTraceFrameSchema, frame)).not.toThrow();
  });

  it("omits the block when the trace recorded no reviewer decision", () => {
    const frame = deriveTraceFrame({
      trace: traceOf([{ id: "c1" }]),
      messageId: "m1",
      chunksById: new Map<string, DocChildById>(),
    });
    expect(frame.technical).not.toHaveProperty("reviewer");
    expect(() => v.parse(ChatTraceFrameSchema, frame)).not.toThrow();
  });

  it("reads the last reviewer-stage decision, and only the reviewer stage's", () => {
    // Append order is the trace's precedence: a re-entered stage appends its new
    // verdict rather than replacing the old one, so the last record is the run's.
    // A decision another stage recorded is not the pre-gate's — and it is the LAST
    // event here, so a stage-blind `findLast` would return its 0.9 threshold and
    // fail the assertion below. That event deliberately shares the pre-gate's
    // purpose, passed explicitly at its call site rather than inherited from the
    // helper, so the stage clause — not the purpose clause — is what excludes it.
    const frame = deriveTraceFrame({
      trace: traceOf(
        [{ id: "c1" }],
        [
          decisionEvent(
            "reviewer",
            { outcome: "escalate", reason: "below_threshold", threshold: 0.5, items: [] },
            7,
          ),
          decisionEvent("router", { outcome: "escalate", threshold: 0.9, items: [] }, 8),
          decisionEvent("reviewer", { outcome: "skip", threshold: 0.5, items: [] }, 9),
          decisionEvent(
            "router",
            { purpose: "citation_support", outcome: "skip", threshold: 0.9, items: [] },
            10,
          ),
        ],
      ),
      messageId: "m1",
      chunksById: new Map<string, DocChildById>(),
    });
    expect(frame.technical.reviewer).toEqual({ outcome: "skip", threshold: 0.5, items: [] });
  });

  it("ignores another screen's decision recorded inside the reviewer stage", () => {
    // The stage is not the screen: a second Decider inside the reviewer stage
    // records its own purpose, and the pre-gate's verdict must not be shadowed by
    // it even though it is the newest decision on the trace.
    const frame = deriveTraceFrame({
      trace: traceOf(
        [{ id: "c1" }],
        [
          decisionEvent(
            "reviewer",
            { outcome: "escalate", reason: "below_threshold", threshold: 0.5, items: [] },
            7,
          ),
          decisionEvent(
            "reviewer",
            { purpose: "answer_completeness", outcome: "skip", threshold: 0.9, items: [] },
            8,
          ),
        ],
      ),
      messageId: "m1",
      chunksById: new Map<string, DocChildById>(),
    });
    expect(frame.technical.reviewer).toEqual({
      outcome: "escalate",
      reason: "below_threshold",
      threshold: 0.5,
      items: [],
    });
  });

  it("projects the verdict without a threshold when the decision event carried none", () => {
    // The verdict is the contract's point: a record without the number it was
    // judged against is shown without that number, never dropped and never given a
    // fabricated threshold.
    const frame = deriveTraceFrame({
      trace: traceOf(
        [{ id: "c1" }],
        [decisionEvent("reviewer", { outcome: "escalate", reason: "no_items", items: [] })],
      ),
      messageId: "m1",
      chunksById: new Map<string, DocChildById>(),
    });
    expect(frame.technical.reviewer).toEqual({
      outcome: "escalate",
      reason: "no_items",
      items: [],
    });
    expect(frame.technical.reviewer).not.toHaveProperty("threshold");
    expect(() => v.parse(ChatTraceFrameSchema, frame)).not.toThrow();
  });
});
