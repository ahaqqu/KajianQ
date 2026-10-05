import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@app/contracts";
import { RunContext, type CostRecord } from "@app/rag-core";
import { createKajianQRouter, type RouterProvider } from "./chat-router";
import { ROUTER_SYSTEM_PROMPT } from "./chat-router-output";
import type { KajianQFilters } from "./filters";
import { PRINCIPLE_TAGS, SUBJECT_AREAS, SUB_QUERY_ROLES } from "./taxonomy";

/**
 * The router stage (#14) — Smart Router stages 1–2 at the seam. It had no test
 * of its own before this ticket, which is how the assembled context ended up
 * carrying the question in the field named `intent` for as long as it did.
 *
 * Every case here is about what the stage *does* with a reply: what it routes
 * to, what it records, and what it refuses to pretend.
 */

const COST: CostRecord = {
  modelId: "stub-router",
  tokensIn: 10,
  tokensOut: 20,
  latencyMs: 5,
  costMicroUsd: 3,
};

type Captured = { turns: readonly { role: string; content: string }[]; personalData: true };

function harness(replyText: string): {
  route: (query: { text: string; filters?: KajianQFilters }) => Promise<unknown>;
  captured: Captured[];
  events: TraceEvent[];
} {
  const captured: Captured[] = [];
  const events: TraceEvent[] = [];
  const provider: RouterProvider = {
    generate: (spec) => {
      captured.push(spec);
      return Effect.succeed({ text: replyText, cost: COST });
    },
  };
  const router = createKajianQRouter(provider);
  return {
    captured,
    events,
    route: (query) =>
      Effect.runPromise(
        Effect.provideService(router.route(query) as never, RunContext, {
          config: {},
          now: () => 7,
          record: (event: TraceEvent) => events.push(event),
        } as never) as never,
      ),
  };
}

const REPLY = JSON.stringify({
  intent: "analogy",
  category: "fikih",
  madzhab: "syafii",
  needsPrinciple: true,
  principleTags: ["yusr"],
  confidence: 0.9,
  reasoning: "the question asks why the rule is lenient",
  subQueries: [
    { text: "keringanan shalat bagi orang sakit", role: "factual" },
    { text: "hadits tentang keringanan shalat", role: "sanad" },
  ],
});

describe("createKajianQRouter", () => {
  it("routes to the classification and the repaired sub-queries", async () => {
    const h = harness(REPLY);
    const routed = (await h.route({ text: "Kenapa shalat orang sakit diringankan?" })) as {
      intent: string;
      confidence?: number;
      reasoning?: string;
      filters: KajianQFilters;
      subQueries: readonly { text: string; role?: string; origin?: string }[];
      attributes: Record<string, unknown>;
    };

    expect(routed.intent).toBe("analogy");
    expect(routed.confidence).toBe(0.9);
    expect(routed.reasoning).toBe("the question asks why the rule is lenient");
    expect(routed.filters).toEqual({ madzhab: "syafii" });
    expect(routed.attributes).toMatchObject({
      category: "fikih",
      needsPrinciple: true,
      principleTags: ["yusr"],
      madzhab: "syafii",
    });
    // The model's two sub-queries, plus the dalil rule the fikih category
    // fired and the principle rule the tag fired — the deterministic half.
    expect(routed.subQueries.map((s) => [s.role, s.origin])).toEqual([
      ["factual", "model"],
      ["sanad", "model"],
      ["principle", "rule"],
      ["dalil", "rule"],
    ]);
  });

  it("sends the question as personal data through the provider seam", async () => {
    const h = harness(REPLY);
    await h.route({ text: "Apa hukum riba?" });
    expect(h.captured).toHaveLength(1);
    expect(h.captured[0]?.personalData).toBe(true);
    expect(h.captured[0]?.turns.at(-1)).toEqual({ role: "user", content: "Apa hukum riba?" });
  });

  it("records the call's cost on the run's trace sink", async () => {
    const h = harness(REPLY);
    await h.route({ text: "Apa hukum riba?" });
    expect(h.events).toEqual([
      { stage: "router", kind: "llm_call", detail: { purpose: "intent" }, cost: COST, at: 7 },
    ]);
  });

  it("falls back to one factual sub-query when the reply is unusable", async () => {
    const h = harness("I cannot answer that.");
    const routed = (await h.route({ text: "Apa hukum riba?" })) as {
      intent: string;
      subQueries: readonly { text: string; role?: string; origin?: string }[];
      attributes: Record<string, unknown>;
    };

    expect(routed.intent).toBe("factual");
    expect(routed.subQueries).toEqual([
      { text: "Apa hukum riba?", role: "factual", origin: "fallback" },
    ]);
    // The Trace must never read the fallback as a classification the model made.
    expect(routed.attributes).toEqual({ fallback: true });
    // The call still happened and still cost money — it is on the trace.
    expect(h.events.map((e) => e.kind)).toEqual(["llm_call"]);
  });

  it("falls back when the model invents an intent", async () => {
    const h = harness(JSON.stringify({ intent: "dalil_umum", subQueries: ["riba"] }));
    const routed = (await h.route({ text: "Apa hukum riba?" })) as { intent: string };
    expect(routed.intent).toBe("factual");
  });

  it("keeps the caller's explicit filters through the fallback", async () => {
    const h = harness(JSON.stringify({ not: "a router reply" }));
    const routed = (await h.route({
      text: "Apa hukum riba?",
      filters: { madzhab: "hambali" },
    })) as { filters: KajianQFilters };
    expect(routed.filters).toEqual({ madzhab: "hambali" });
  });

  it("offers exactly the declared vocabularies in the prompt", () => {
    // One source of truth: a value added to the taxonomy without reaching the
    // prompt would be unclassifiable, and a value the prompt offers that the
    // taxonomy does not declare would be dropped on arrival.
    for (const value of [...SUBJECT_AREAS, ...PRINCIPLE_TAGS, ...SUB_QUERY_ROLES]) {
      expect(ROUTER_SYSTEM_PROMPT, `prompt is missing "${value}"`).toContain(value);
    }
  });
});
