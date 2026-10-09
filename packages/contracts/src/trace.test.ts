import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
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
 * `llm_call` is the cost-carrying event kind, so the cost-sum invariants
 * (ADR-0007) are expressed over it. `cost` is built conditionally
 * so the generated value omits the key when undefined — matching the exact
 * optionality of the typed contract.
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
  // ADR-0007 invariant: a run's recorded cost equals the sum of its
  // recorded LLM calls — an untraced call is a defect.
  //
  // The properties below test *independent* invariants rather than mirroring
  // the body of `totalCostMicroUsd` (which would make the test tautological):
  //   1. an event with no cost leaves the total unchanged;
  //   2. an event carrying cost `k` increases the total by exactly `k`;
  //   3. the total equals a *separately computed* sum — filter events that
  //      carry a cost, then reduce their `costMicroUsd` — rather than the
  //      same optional-chain expression the implementation uses.
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
      // Independent computation: keep only cost-bearing events first, then
      // sum — a different shape from the implementation's optional chain.
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
        // and the search retried unfiltered. Recorded, never silent. The example
        // keys stay domain-neutral — this is an engine package.
        stage: "retriever",
        kind: "filter_relaxed",
        detail: { dropped: { layer: "commentary" }, track: "primary" },
        at: 3,
      },
      {
        // Scope expansion (ADR-0045): the retriever added a bounded set of
        // children belonging to a scope the domain pack named, alongside the
        // fused hits. `key`/`value` stay generic here — the domain pack owns
        // what they mean — and the cap/truncated fields make the budget the
        // expansion spent observable.
        stage: "retriever",
        kind: "scope_expansion",
        detail: { key: "reference", value: "2", returned: 12, cap: 12, truncated: true },
        at: 3,
      },
      {
        // Neighbourhood expansion (ADR-0049): the retriever added the children
        // neighbouring the verses already in context. `anchors` names the ids
        // the read was keyed on — in its priority order — so a reader can
        // resolve every added ref to the read that produced it. Engine package,
        // so the ids stay opaque placeholders.
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
        stage: "assembler",
        kind: "assembly",
        detail: { turnCount: 2, chunkCount: 1 },
        at: 4,
      },
      {
        stage: "generator",
        kind: "llm_call",
        detail: { purpose: "generate" },
        cost: { modelId: "m", tokensIn: 1, tokensOut: 2, latencyMs: 3, costMicroUsd: 4 },
        at: 5,
      },
      { stage: "reviewer", kind: "review", detail: { verdict: "faithful" }, at: 6 },
      {
        // The deterministic product rules ran (#285): the rule ids that
        // appended text are persisted trace content, recorded on every path
        // that applies the rules — including the pre-gate skip path below,
        // which records no `review` event. The ids are deliberately opaque
        // placeholders here: a domain pack owns their meaning, and the engine
        // contract must not know it (the boundary gate enforces that).
        stage: "reviewer",
        kind: "product_rules",
        detail: { applied: ["rule_one", "rule_two"] },
        at: 6,
      },
      {
        // The decision-model screen (ADR-0042 serving pattern): the skip and
        // its per-item scores are persisted trace content, and the call's own
        // spend rides on the sibling `llm_call` event above.
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
      { stage: "generator", kind: "refusal", reason: "insufficient evidence", at: 8 },
    ];
    const trace = parseTrace({ id: "t", createdAt: 0, events });
    // 12 = the base rows plus BOTH sides' additions: main's
    // `neighbour_expansion` (ADR-0049) and this branch's `product_rules`
    // (#285). A count is not enough on its own — it cannot tell "both
    // variants are in the union" from "one replaced the other" — so the
    // kinds are named: `v.variant` throws on a kind the union does not carry,
    // and the list is the record that both additions survived the re-layout.
    expect(trace.events).toHaveLength(12);
    expect(trace.events.map((event) => event.kind)).toEqual([
      "intent",
      "subquery",
      "retrieval",
      "filter_relaxed",
      "scope_expansion",
      "neighbour_expansion",
      "assembly",
      "llm_call",
      "review",
      "product_rules",
      "decision",
      "refusal",
    ]);
  });

  // Schema invariant (ADR-0007 typed detail): the variant is lossless — any
  // list of non-empty rule ids the domain pack reports survives the parse
  // unchanged, and the empty list survives as the empty list rather than being
  // dropped or defaulted. Hand-picked values would not cover the id space the
  // domain pack owns, which is exactly the space this event persists.
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

  it("accepts an empty `applied` list — the rules ran and appended nothing (#285)", () => {
    // The exact-copy suppression case is the reason this event exists: the
    // model reproduced the canonical copy, so the rule found it already
    // present and appended nothing. An empty list records exactly that — "the
    // rules ran and appended nothing" — without separating it from a run where
    // no rule had a trigger, so a `minLength(1)` on the array (or treating []
    // as absent) would erase the record and put the trace back where it
    // started.
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
    // A blank id names no rule, so it cannot be counted per rule — the one
    // thing an operator or the eval harness reads this event for.
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
    // ADR-0007 forward compatibility, the direction that matters: traces
    // written before the `product_rules` kind existed (e.g. the #278 staging
    // trace dfd9d801, which carries a pre-gate `decision` skip and NO `review`
    // event) still parse — nothing was renamed or made required, and the
    // reader must not synthesize the event it never saw. The fixture is the
    // shape the runner really persists: `run.ts` builds exactly `{ id,
    // createdAt, events }` and no writer in the repo stamps `version`, so the
    // version-less body IS the production shape, not a pre-versioning piece.
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
    // The parse result is what is asserted, not the input echoed back: the
    // version-less shape reads, no version is fabricated, and every event kind
    // survives the strict variant in order.
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
    // Forward compatibility is the contract's rule (ADR-0007): a trace
    // persisted before the field existed parses, and the absent label simply
    // means "no caller label" — never a fabricated one.
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
    // The reason vocabulary is closed on purpose: an operator (and the eval
    // harness) counts escalations by reason, so a free string would make the
    // failure modes uncountable.
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
    // The event's whole point is that an added chunk resolves to the read that
    // produced it, which is `anchors` + `radius`; a record without either is
    // the silent path the trace rule exists to prevent, so it fails the parse
    // rather than being persisted as an untyped detail.
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
 * Smart Router stage 3's decision on the trace (#15), and the relaxation events
 * that qualify it.
 *
 * The persisted-trace invariant these variants exist for: the routing decision
 * — which sources were searched and with which filters — is derivable from the
 * trace, and the relaxation that follows it says which dimension was given up.
 * A schema that let either side be recorded loosely (an untyped bag, a
 * single-valued filter map) would let the trace and the search drift apart with
 * nothing failing.
 */
describe("the source_routing variant", () => {
  const base = { id: "6b1a1e0e-0f4e-4c4c-9b1e-2a2f5f7c9d10", createdAt: 0 };

  it("carries the selected sources and the filter record retrieval runs with", () => {
    // Opaque labels only: this is the engine contract, and the sources and
    // filter dimensions a domain pack names must not appear in it.
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
    // "Every source was in play" is a decision, not a missing field: the run
    // must be able to say so rather than omit the event.
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
    // The store binds strings and string arrays; anything else cannot be
    // searched, so it must not be persistable as if it had been. An EMPTY set is
    // included: `key = ANY('{}')` matches nothing, so a record carrying one would
    // read as "this dimension was constrained" while emptying the search.
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
    // Traces persisted before this ticket recorded one event naming the whole
    // dropped record with single string values; a panel that read them must
    // keep rendering (ADR-0007: the Trace only ever ADDS optional fields).
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
