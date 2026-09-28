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
 * (ADR-0007 amendment) are expressed over it. `cost` is built conditionally
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
  // ADR-0007 amendment invariant: a run's recorded cost equals the sum of its
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
    expect(trace.events).toHaveLength(11);
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
    // present and appended nothing. An empty list is that signal; a
    // `minLength(1)` on the array (or treating [] as absent) would erase it
    // and put the trace back where it started.
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
    // event) still parse — `version` stays 1, nothing was renamed or made
    // required, and the reader must not synthesize the event it never saw.
    const legacy = parseTrace({
      id: "dfd9d801-c3bc-42b9-9e09-39a5df785c94",
      version: 1,
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
    expect(legacy.version).toBe(1);
    expect(legacy.events).toHaveLength(4);
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
