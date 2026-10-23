import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";
import { TraceSchema, parseTrace, totalCostMicroUsd, type TraceEvent } from "./trace";

const costArb = fc.record({
  modelId: fc.string({ minLength: 1 }),
  tokensIn: fc.nat(),
  tokensOut: fc.nat(),
  latencyMs: fc.nat(),
  costMicroUsd: fc.nat(),
});

const stageArb = fc.constantFrom(
  "router",
  "retriever",
  "assembler",
  "generator",
  "reviewer",
  "ingest",
  "eval",
);

/**
 * `llm_call` is the cost-carrying event kind, so the cost-sum invariants are
 * expressed over it. `cost` is built conditionally so the generated value omits
 * the key when undefined, matching the typed contract's optionality.
 */
const llmCallArb = fc
  .tuple(stageArb, fc.nat(), fc.option(costArb, { nil: undefined }))
  .map(([stage, at, cost]) => ({
    stage,
    kind: "llm_call" as const,
    at,
    ...(cost === undefined ? {} : { cost }),
  }));

describe("trace contract", () => {
  // Invariant: a run's recorded cost equals the sum of its recorded LLM calls,
  // and an untraced call is a defect. The properties test independent invariants
  // rather than mirroring `totalCostMicroUsd`, which would make them tautological.
  fcTest.prop([fc.array(llmCallArb), costArb])(
    "appending an event with cost k increases the total by exactly k",
    (events, cost) => {
      const before = totalCostMicroUsd({ id: "t", createdAt: 0, events });
      const after = totalCostMicroUsd({
        id: "t",
        createdAt: 0,
        events: [...events, { stage: "generator", kind: "llm_call", cost, at: 0 }],
      });
      expect(after).toBe(before + cost.costMicroUsd);
    },
  );

  fcTest.prop([fc.array(llmCallArb), stageArb])(
    "appending an event without cost does not change the total",
    (events, stage) => {
      const before = totalCostMicroUsd({ id: "t", createdAt: 0, events });
      const after = totalCostMicroUsd({
        id: "t",
        createdAt: 0,
        events: [...events, { stage, kind: "llm_call", at: 0 }],
      });
      expect(after).toBe(before);
    },
  );

  fcTest.prop([fc.array(llmCallArb)])(
    "total equals the sum of costMicroUsd over cost-bearing events",
    (events) => {
      const trace = { id: "t", createdAt: 0, events };
      // Independent computation: filter cost-bearing events first, then sum.
      const expected = events
        .filter((e) => e.cost !== undefined)
        .reduce((sum, e) => sum + (e.cost?.costMicroUsd ?? 0), 0);
      expect(totalCostMicroUsd(trace)).toBe(expected);
    },
  );

  it("parses a trace with one event of each kind", () => {
    const events: TraceEvent[] = [
      {
        stage: "router",
        kind: "intent",
        detail: { intent: "factual", confidence: 0.9, attributes: { scope: "all" } },
        at: 1,
      },
      { stage: "router", kind: "subquery", detail: { text: "sub" }, at: 2 },
      {
        stage: "retriever",
        kind: "retrieval",
        detail: {
          chunks: [{ id: "c1", score: 0.5, rankDense: 1, rankSparse: 2, origin: "expansion" }],
        },
        at: 3,
      },
      {
        // Filter relaxation: an inferred filter that matched nothing was dropped
        // and the search retried without it.
        stage: "retriever",
        kind: "filter_relaxed",
        detail: { dropped: { layer: "commentary" }, track: "primary" },
        at: 3,
      },
      {
        // Scope expansion: the retriever added a bounded set of children of a
        // scope the domain pack named; `key`/`value` stay generic.
        stage: "retriever",
        kind: "scope_expansion",
        detail: { key: "reference", value: "2", returned: 12, cap: 12, truncated: true },
        at: 3,
      },
      {
        // Neighbourhood expansion: the children neighbouring the verses already in
        // context; `anchors` names the ids the read was keyed on, in priority order.
        stage: "retriever",
        kind: "neighbour_expansion",
        detail: {
          anchors: ["c1", "c2"],
          returned: 3,
          radius: 1,
          cap: 12,
          truncated: false,
        },
        at: 3,
      },
      {
        // Citation-label lookup: the retriever read the chunks the question's own
        // label addresses; `labels` are the normalized labels and `missing` names
        // the ones the store did not carry.
        stage: "retriever",
        kind: "citation_lookup",
        detail: {
          labels: ["HR. Bukhari no. 4697"],
          missing: [],
          returned: 1,
          cap: 8,
          truncated: false,
        },
        at: 3,
      },
      {
        stage: "assembler",
        kind: "assembly",
        detail: { turnCount: 2, chunkCount: 1 },
        at: 4,
      },
      {
        stage: "generator",
        kind: "llm_call",
        // The directed second reading names the evidence it was pointed at; a
        // plain reading omits the field.
        detail: { purpose: "generate_addressed_reread", addressed: ["QS. 98:5"] },
        cost: { modelId: "m", tokensIn: 1, tokensOut: 2, latencyMs: 3, costMicroUsd: 4 },
        at: 5,
      },
      { stage: "reviewer", kind: "review", detail: { verdict: "faithful" }, at: 6 },
      {
        // The deterministic product rules ran: the rule ids that changed the
        // delivered text are persisted trace content, kept opaque — a domain pack
        // owns their meaning.
        stage: "reviewer",
        kind: "product_rules",
        detail: { applied: ["rule_one", "rule_two"] },
        at: 6,
      },
      {
        // The decision screen's skip and per-item scores are trace content; the
        // call's spend rides on the sibling `llm_call` above.
        stage: "reviewer",
        kind: "decision",
        detail: {
          purpose: "citation_support",
          outcome: "skip",
          threshold: 0.5,
          items: [
            { index: 0, key: "citation-1", score: 0.94 },
            { index: 1, key: "citation-2", score: 0.5 },
          ],
        },
        at: 7,
      },
      {
        // The retrieval rerank's ranking: both scores per candidate and the
        // rank each landed on; the call's spend rides the sibling `llm_call`.
        stage: "retriever",
        kind: "rerank",
        detail: {
          purpose: "rerank",
          outcome: "applied",
          items: [
            { index: 0, key: "chunk-a", fusedScore: 0.03, rerankScore: 0.1, rankAfter: 1 },
            { index: 1, key: "chunk-b", fusedScore: 0.02, rerankScore: 0.9, rankAfter: 0 },
          ],
        },
        at: 8,
      },
      { stage: "generator", kind: "refusal", reason: "insufficient evidence", at: 9 },
    ];
    const trace = parseTrace({ id: "t", createdAt: 0, events });
    // The kinds are named, not just counted: a count cannot tell "both variants
    // are in the union" from "one replaced the other".
    expect(trace.events).toHaveLength(14);
    expect(trace.events.map((event) => event.kind)).toEqual([
      "intent",
      "subquery",
      "retrieval",
      "filter_relaxed",
      "scope_expansion",
      "neighbour_expansion",
      "citation_lookup",
      "assembly",
      "llm_call",
      "review",
      "product_rules",
      "decision",
      "rerank",
      "refusal",
    ]);
  });

  // The variant is lossless: any list of rule ids the domain pack reports survives
  // the parse unchanged, and the empty list stays empty rather than defaulted.
  fcTest.prop([fc.array(fc.string({ minLength: 1 }), { maxLength: 5 })])(
    "round-trips a product_rules event's `applied` list unchanged (#285)",
    (applied) => {
      const trace = parseTrace({
        id: "t",
        createdAt: 0,
        events: [{ stage: "reviewer", kind: "product_rules", detail: { applied }, at: 1 }],
      });
      const event = trace.events[0];
      expect(event?.kind === "product_rules" ? event.detail.applied : undefined).toEqual(applied);
    },
  );

  it("accepts an empty `applied` list — the rules ran and changed nothing (#285)", () => {
    // An empty list records "the rules ran and changed nothing": a `minLength(1)`
    // on the array, or treating `[]` as absent, would erase that record.
    const parsed = v.safeParse(TraceSchema, {
      id: "t",
      createdAt: 1,
      events: [{ stage: "reviewer", kind: "product_rules", detail: { applied: [] }, at: 1 }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const event = parsed.output.events[0];
      expect(event?.kind === "product_rules" ? event.detail.applied : undefined).toEqual([]);
    }
  });

  it("rejects a product_rules event without an applied list", () => {
    expect(
      v.safeParse(TraceSchema, {
        id: "t",
        createdAt: 1,
        events: [{ stage: "reviewer", kind: "product_rules", detail: {}, at: 1 }],
      }).success,
    ).toBe(false);
  });

  it("rejects a product_rules rule id that is not a non-empty string", () => {
    // A blank id names no rule, so it cannot be counted per rule.
    expect(
      v.safeParse(TraceSchema, {
        id: "t",
        createdAt: 1,
        events: [{ stage: "reviewer", kind: "product_rules", detail: { applied: [""] }, at: 1 }],
      }).success,
    ).toBe(false);
  });

  it("rejects a product_rules event recorded on a stage that does not apply the rules", () => {
    expect(
      v.safeParse(TraceSchema, {
        id: "t",
        createdAt: 1,
        events: [{ stage: "generator", kind: "product_rules", detail: { applied: ["x"] }, at: 1 }],
      }).success,
    ).toBe(false);
  });

  it("keeps a pre-#285 persisted trace readable, with no fabricated product_rules event", () => {
    // Forward compatibility: a trace that carries no `product_rules` event still
    // parses — nothing was renamed or made required, and the reader must not
    // synthesize an event it never saw. `run.ts` builds exactly `{ id,
    // createdAt, events }`, so the version-less body is the production shape.
    const legacy = parseTrace({
      id: "dfd9d801-c3bc-42b9-9e09-39a5df785c94",
      createdAt: 0,
      events: [
        {
          stage: "retriever",
          kind: "retrieval",
          detail: { chunks: [{ id: "c1", score: 0.5, rankDense: 1, rankSparse: 2 }] },
          at: 1,
        },
        { stage: "assembler", kind: "assembly", detail: { turnCount: 2, chunkCount: 1 }, at: 2 },
        {
          stage: "generator",
          kind: "llm_call",
          detail: { purpose: "generate" },
          cost: { modelId: "m", tokensIn: 1, tokensOut: 2, latencyMs: 3, costMicroUsd: 4 },
          at: 3,
        },
        {
          stage: "reviewer",
          kind: "decision",
          detail: {
            purpose: "citation_support",
            outcome: "skip",
            threshold: 0.5,
            items: [{ index: 0, key: "citation-1", score: 0.94 }],
          },
          at: 4,
        },
      ],
    });
    expect(legacy.version).toBeUndefined();
    expect(legacy.events.map((event) => event.kind)).toEqual([
      "retrieval",
      "assembly",
      "llm_call",
      "decision",
    ]);
    expect(legacy.events.some((event) => event.kind === "product_rules")).toBe(false);
  });

  it("keeps a chunk ref without `origin` readable (pre-ADR-0045 traces)", () => {
    // Forward compatibility: a chunk ref without `origin` parses, and the absent
    // label means "no caller label", never a fabricated one.
    const trace = parseTrace({
      id: "t",
      createdAt: 0,
      events: [
        {
          stage: "retriever",
          kind: "retrieval",
          detail: { chunks: [{ id: "c1", score: 0.5, rankDense: 1, rankSparse: 2 }] },
          at: 1,
        },
      ],
    });
    const ref =
      trace.events[0]?.kind === "retrieval" ? trace.events[0].detail.chunks[0] : undefined;
    expect(ref?.origin).toBeUndefined();
  });

  it("rejects a decision event without an outcome", () => {
    expect(
      v.safeParse(TraceSchema, {
        id: "t",
        createdAt: 1,
        events: [{ stage: "reviewer", kind: "decision", detail: { items: [] }, at: 1 }],
      }).success,
    ).toBe(false);
  });

  it("rejects a decision escalation reason outside the fail-open vocabulary", () => {
    // The reason vocabulary is closed on purpose: escalations are counted by
    // reason, so a free string would make the failure modes uncountable.
    expect(
      v.safeParse(TraceSchema, {
        id: "t",
        createdAt: 1,
        events: [
          {
            stage: "reviewer",
            kind: "decision",
            detail: { outcome: "escalate", reason: "felt-wrong", items: [] },
            at: 1,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts an unscored decision item (a vendor failure never invents a score)", () => {
    expect(
      v.safeParse(TraceSchema, {
        id: "t",
        createdAt: 1,
        events: [
          {
            stage: "reviewer",
            kind: "decision",
            detail: {
              outcome: "escalate",
              reason: "vendor_failure",
              threshold: 0.5,
              items: [{ index: 0, key: "citation-1" }],
            },
            at: 1,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(
      v.safeParse(TraceSchema, {
        id: "t",
        createdAt: 1,
        events: [{ stage: "generator", kind: "x", at: 1 }],
      }).success,
    ).toBe(false);
  });

  it("rejects a refusal without a reason", () => {
    expect(
      v.safeParse(TraceSchema, {
        id: "t",
        createdAt: 1,
        events: [{ stage: "generator", kind: "refusal", at: 1 }],
      }).success,
    ).toBe(false);
  });

  it("rejects an intent event on the wrong stage", () => {
    expect(
      v.safeParse(TraceSchema, {
        id: "t",
        createdAt: 1,
        events: [{ stage: "retriever", kind: "intent", detail: { intent: "x" }, at: 1 }],
      }).success,
    ).toBe(false);
  });

  it("rejects a neighbour expansion without its anchors or budget (ADR-0049)", () => {
    // An added chunk must resolve to the read that produced it, which is `anchors`
    // + `radius`; a record without either is the silent path the trace prevents.
    for (const detail of [
      undefined,
      { returned: 1, radius: 1, cap: 2, truncated: false },
      { anchors: [], returned: 1, radius: 1, cap: 2 },
      { anchors: [""], returned: 1, radius: 1, cap: 2, truncated: false },
      { anchors: ["c1"], returned: -1, radius: 1, cap: 2, truncated: false },
      { anchors: ["c1"], returned: 1, radius: 1, cap: 2, truncated: "no" },
    ]) {
      expect(
        v.safeParse(TraceSchema, {
          id: "t",
          createdAt: 1,
          events: [
            {
              stage: "retriever",
              kind: "neighbour_expansion",
              ...(detail !== undefined ? { detail } : {}),
              at: 1,
            },
          ],
        }).success,
        JSON.stringify(detail),
      ).toBe(false);
    }
  });

  it("rejects a malformed intent detail", () => {
    expect(
      v.safeParse(TraceSchema, {
        id: "t",
        createdAt: 1,
        events: [{ stage: "router", kind: "intent", detail: { nope: true }, at: 1 }],
      }).success,
    ).toBe(false);
  });
});

/**
 * The source-routing decision on the trace and the relaxation events that
 * qualify it: which sources were searched and with which filters is derivable
 * from the trace. A schema that recorded either side loosely (an untyped bag, a
 * single-valued filter map) would let the trace and the search drift apart with
 * nothing failing.
 */
describe("the source_routing variant", () => {
  const base = { id: "6b1a1e0e-0f4e-4c4c-9b1e-2a2f5f7c9d10", createdAt: 0 };

  it("carries the selected sources and the filter record retrieval runs with", () => {
    // Opaque labels only: the sources and filter dimensions a domain pack names
    // must not appear in the engine contract.
    const trace = parseTrace({
      ...base,
      events: [
        {
          stage: "router",
          kind: "source_routing",
          detail: {
            sources: ["src_a", "src_b"],
            filters: { dim_a: ["src_a"], dim_b: ["v1", "v2"], dim_c: ["v3"] },
          },
          durationMs: 4,
          at: 1,
        },
      ],
    });
    expect(trace.events[0]).toMatchObject({
      kind: "source_routing",
      detail: { filters: { dim_b: ["v1", "v2"] } },
    });
  });

  it("accepts an EMPTY source list and an empty filter record as a decision", () => {
    // "Every source was in play" is a decision, not a missing field.
    expect(() =>
      parseTrace({
        ...base,
        events: [
          { stage: "router", kind: "source_routing", detail: { sources: [], filters: {} }, at: 1 },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects a filter value that is not a non-empty list of non-empty strings", () => {
    // The store binds strings and string arrays; anything else cannot be searched
    // and must not be persistable as if it had been. An EMPTY set is refused too:
    // `key = ANY('{}')` matches nothing, so it would read as "constrained" while
    // emptying the search.
    for (const filters of [{ dim_a: "v1" }, { dim_a: [] }, { dim_a: ["v1", ""] }, { dim_a: [1] }]) {
      expect(() =>
        parseTrace({
          ...base,
          events: [
            {
              stage: "router",
              kind: "source_routing",
              detail: { sources: ["src_a"], filters },
              at: 1,
            },
          ],
        }),
      ).toThrow();
    }
  });
});

describe("the filter_relaxed event after probing replaced the whole-set drop", () => {
  const base = { id: "8f0f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b", createdAt: 0 };

  it("still parses a pre-probing event whose dropped values were bare strings", () => {
    // A `dropped` value may be a bare string as well as a list: a reader must keep
    // rendering both, and the Trace only ever ADDS optional fields.
    const trace = parseTrace({
      ...base,
      events: [
        {
          stage: "retriever",
          kind: "filter_relaxed",
          detail: { dropped: { dim_a: "v1", dim_b: "v2" }, track: "primary" },
          at: 1,
        },
      ],
    });
    expect(trace.events[0]).toMatchObject({ kind: "filter_relaxed" });
  });

  it("records one dimension per event, the record the retry ran with, and whether it was adopted", () => {
    const trace = parseTrace({
      ...base,
      events: [
        {
          stage: "retriever",
          kind: "filter_relaxed",
          detail: {
            dropped: { dim_a: ["v1"] },
            retained: { dim_b: ["v2"] },
            adopted: true,
            track: "primary",
            hits: 3,
          },
          at: 1,
        },
        {
          stage: "retriever",
          kind: "filter_relaxed",
          detail: {
            dropped: { dim_b: ["v2"] },
            retained: { dim_c: ["v3"] },
            adopted: false,
            track: "fallback",
            hits: 0,
          },
          at: 2,
        },
      ],
    });
    expect(trace.events).toHaveLength(2);
  });
});
