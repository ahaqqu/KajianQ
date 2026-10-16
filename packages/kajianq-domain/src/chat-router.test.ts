import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@app/contracts";
import { RunContext, StageError, type CostRecord } from "@app/rag-core";
import { createKajianQRouter, type RouterProvider } from "./chat-router";
import { ROUTER_SYSTEM_PROMPT } from "./chat-router-output";
import type { KajianQFilters } from "./filters";
import { GRADES, MADZHABS, TEXT_LAYERS } from "./filters";
import { INTENTS, PRINCIPLE_TAGS, SUBJECT_AREAS, SUB_QUERY_ROLES } from "./taxonomy";

/**
 * The router stage — Smart Router stages 1–2 at the seam. Every case here is about
 * what the stage *does* with a reply: what it routes to, what it records, and what
 * it refuses to pretend.
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
    // Stage 3's decision, not the reply's hints: a fikih question is answered from
    // Quran, Sunnah and Kitab, `needsPrinciple` puts the Principle Index in play, and
    // the reply's own madzhab/Principle hints ride along as the sets the store binds.
    expect(routed.filters).toEqual({
      madzhab: ["syafii"],
      sourceType: ["quran", "hadith", "kitab", "principle"],
      principleTags: ["yusr"],
    });
    expect(routed.attributes).toMatchObject({
      category: "fikih",
      needsPrinciple: true,
      principleTags: ["yusr"],
      madzhab: ["syafii"],
      sourceType: ["quran", "hadith", "kitab", "principle"],
    });
    expect(routed.subQueries.map((s) => [s.role, s.origin])).toEqual([
      ["factual", "model"],
      ["sanad", "model"],
      ["principle", "rule"],
      ["dalil", "rule"],
    ]);
  });

  it("searches every source the route's own parts imply — the gs-v0-015 shape", async () => {
    const h = harness(
      JSON.stringify({
        intent: "comparison",
        category: "tafsir",
        needsPrinciple: false,
        subQueries: [
          { text: "makna Surah Al-Fatihah", role: "factual" },
          { text: "mengapa dibaca dalam setiap salat", role: "factual" },
          { text: "hadith no prayer for one who does not recite Al-Fatihah", role: "dalil" },
        ],
      }),
    );
    const routed = (await h.route({
      text: "What does Surah Al-Fatihah mean and why is it recited in every prayer?",
    })) as { filters: KajianQFilters };

    expect(routed.filters.sourceType).toEqual(["quran", "tafsir", "hadith"]);
    // The record the trace publishes IS the record retrieval is handed — one
    // derivation, so the decision and the search cannot drift apart.
    expect(h.events.at(-1)).toEqual({
      stage: "router",
      kind: "source_routing",
      detail: {
        sources: ["quran", "tafsir", "hadith"],
        filters: { sourceType: ["quran", "tafsir", "hadith"] },
      },
      at: 7,
    });
  });

  it("puts a role's source in the filter where the category row names no such source", async () => {
    // The role union made load-bearing: the category row (`quran` → `["quran"]`)
    // contains no `hadith`, so the reply's own `dalil` part is the only thing that can
    // select it — deleting the union loop reddens this case, and no row widening can
    // rescue it. The invariant is route-wide coverage: every part the route decomposed
    // is searchable.
    const h = harness(
      JSON.stringify({
        intent: "ruling",
        category: "quran",
        needsPrinciple: false,
        subQueries: [{ text: "dalil tentang keutamaan membaca Al-Quran", role: "dalil" }],
      }),
    );
    const routed = (await h.route({ text: "Apa keutamaan membaca Al-Quran?" })) as {
      filters: KajianQFilters;
      subQueries: readonly { text: string; role?: string; origin?: string }[];
    };

    // The union reads the set retrieval fans out over, not the reply's raw list.
    expect(routed.subQueries.map((s) => [s.role, s.origin])).toEqual([
      ["dalil", "model"],
      ["factual", "rule"],
    ]);
    expect(routed.filters.sourceType).toEqual(["quran", "hadith"]);
    expect(h.events.at(-1)).toMatchObject({
      kind: "source_routing",
      detail: {
        sources: ["quran", "hadith"],
        filters: { sourceType: ["quran", "hadith"] },
      },
    });
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
      {
        stage: "router",
        kind: "source_routing",
        detail: {
          sources: ["quran", "hadith", "kitab", "principle"],
          // The record retrieval is handed, keyed as the store binds it — the
          // routing decision is on the trace, not only in the router's prose.
          filters: {
            sourceType: ["quran", "hadith", "kitab", "principle"],
            madzhab: ["syafii"],
            principleTags: ["yusr"],
          },
        },
        at: 7,
      },
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
    // The call still happened and still cost money — it is on the trace. And
    // the route that understood nothing selected NO source and recorded that
    // as a decision: an EMPTY `sources` list, never a missing event, so "every
    // source was in play" cannot read the same as "nothing was recorded".
    expect(h.events.map((e) => e.kind)).toEqual(["llm_call", "source_routing"]);
    expect(h.events.at(-1)).toMatchObject({
      kind: "source_routing",
      detail: { sources: [], filters: {} },
    });
  });

  it("falls back when the model invents an intent", async () => {
    const h = harness(JSON.stringify({ intent: "dalil_umum", subQueries: ["riba"] }));
    const routed = (await h.route({ text: "Apa hukum riba?" })) as { intent: string };
    expect(routed.intent).toBe("factual");
  });

  it("declines to route a question that carries no content, without asking the model", async () => {
    // The route gate: a text with no letter and no digit is not a question, so
    // there is nothing to classify and nothing to decompose. The stage asks the
    // model nothing — a model asked for sub-queries of a non-question invents
    // them — and returns the deterministic route over an empty fan-out, which is
    // what leaves retrieval nothing to embed and nothing to search. The
    // `contentFree` flag is what tells this route apart from the unusable-reply
    // fallback on the trace; both are nobody's model reading.
    for (const question of ["\u200b\u200d\u200b", "\u0001\u0007", "😀🔥", "!!", "   "]) {
      const h = harness("I cannot answer that.");
      const routed = (await h.route({ text: question })) as {
        intent: string;
        subQueries: readonly unknown[];
        attributes: Record<string, unknown>;
      };
      expect(routed.intent).toBe("factual");
      expect(routed.subQueries).toEqual([]);
      expect(routed.attributes).toEqual({ fallback: true, contentFree: true });
      // No call, so no `llm_call` event either: the trace carries the decision the
      // stage made, and the decision was to spend nothing.
      expect(h.captured).toEqual([]);
      expect(h.events.map((e) => e.kind)).toEqual(["source_routing"]);
      expect(h.events.at(-1)).toMatchObject({
        kind: "source_routing",
        detail: { sources: [], filters: {} },
      });
    }
  });

  it("routes a question that carries content past the gate and into the model call", async () => {
    // The gate is on the text, not on the route: one letter or one digit — any
    // script, a bare numeral included — and the stage routes as it always did.
    for (const question of ["riba", "5", "٥", "漢字", "الربا", "\u200briba"]) {
      const h = harness(REPLY);
      const routed = (await h.route({ text: question })) as {
        subQueries: readonly { text: string; role?: string; origin?: string }[];
      };
      expect(h.captured).toHaveLength(1);
      expect(routed.subQueries.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("trims the fallback's sub-query text like every other origin", async () => {
    // The fallback takes the whole admission, not half of it: the content test and the
    // trim come from one owner, so a padded question cannot reach the embed and the
    // persisted `subquery` event untrimmed while the decompose arm trims the same text
    // (`SPECS.md` §3.3, "padded text is kept trimmed").
    for (const question of ["  riba  ", "\triba\n"]) {
      const h = harness("I cannot answer that.");
      const routed = (await h.route({ text: question })) as {
        subQueries: readonly { text: string; role?: string; origin?: string }[];
      };
      expect(routed.subQueries).toEqual([{ text: "riba", role: "factual", origin: "fallback" }]);
    }
  });

  it("keeps the caller's explicit filters through the fallback", async () => {
    const h = harness(JSON.stringify({ not: "a router reply" }));
    const routed = (await h.route({
      text: "Apa hukum riba?",
      filters: { madzhab: ["hambali"] },
    })) as { filters: KajianQFilters; attributes: Record<string, unknown> };
    expect(routed.filters).toEqual({ madzhab: ["hambali"] });
    // The fallback applied those filters to retrieval, so the payload that says what
    // was understood carries them too — `{fallback: true}` alone would leave a trace
    // reader unable to tell what the route ran with.
    expect(routed.attributes).toEqual({ fallback: true, madzhab: ["hambali"] });
  });

  it("fails the stage typed on a caller filter the store cannot express — on either arm", async () => {
    // A caller can pin a dimension retrieval cannot bind (`Query.filters`), and
    // `sourceRoutingDetail` throws on it. Both arms record their decision through the
    // same boundary, so both land on the stage's declared `StageError`: a throw that
    // escaped as a defect would make `Effect<Routing, StageError>` untrue, and the
    // reply arm must not be the only one that holds.
    const filters = { not_a_dimension: ["x"] } as unknown as KajianQFilters;
    const cases: readonly { why: string; text: string; reply: string }[] = [
      { why: "the gate's arm", text: "\u200b\u200d", reply: JSON.stringify({ not: "a reply" }) },
      { why: "the reply arm", text: "Apa hukum riba?", reply: JSON.stringify({ not: "a reply" }) },
    ];
    for (const { why, text, reply } of cases) {
      const h = harness(reply);
      const error = await h.route({ text, filters }).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(error, why).toBeInstanceOf(StageError);
      expect((error as StageError).stage, why).toBe("router");
    }
  });

  it("stamps the factual rule onto a model echo of the question with no role", async () => {
    // Reachable from the wire: `SubQueryReplySchema` accepts a bare string, so a cheap
    // reply can hand over exactly the question with no role. The stage must still label
    // the rule it fired, without duplicating the retrieval text (see
    // chat-router-decompose.test.ts).
    const h = harness(JSON.stringify({ intent: "factual", subQueries: ["Apa hukum riba?"] }));
    const routed = (await h.route({ text: "Apa hukum riba?" })) as {
      subQueries: readonly { text: string; role?: string; origin?: string }[];
    };
    expect(routed.subQueries).toEqual([
      { text: "Apa hukum riba?", role: "factual", origin: "model" },
    ]);
  });

  it("offers exactly the declared vocabularies in the prompt", () => {
    // The prompt *composes* its vocabulary lists from their owners (taxonomy, filters)
    // rather than re-spelling them, so a value cannot reach the reader unrequested.
    // This asserts the forward direction over every one of those lists.
    //
    // The reverse direction — a vocabulary value in the prompt that no list declares —
    // is not asserted here, and this loop cannot assert it: the prompt's one
    // hand-written line (the `subQueries` rules) names `factual`, `principle`, `dalil`,
    // `sanad` and the two subject areas it keys on as prose. What ties those names to
    // their lists is the compiler, not this test: `chat-router-output.ts` names each
    // through the owner's own type, so renaming one there fails the build. A vocabulary
    // literal hand-written anywhere else would be this test's blind spot.
    for (const value of [
      ...INTENTS,
      ...SUBJECT_AREAS,
      ...PRINCIPLE_TAGS,
      ...SUB_QUERY_ROLES,
      ...MADZHABS,
      ...GRADES,
      ...TEXT_LAYERS,
    ]) {
      expect(ROUTER_SYSTEM_PROMPT, `prompt is missing "${value}"`).toContain(value);
    }
  });
});
