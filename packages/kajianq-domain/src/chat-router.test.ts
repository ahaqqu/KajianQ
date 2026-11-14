import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { TraceEvent } from "@app/contracts";
import { RunContext, StageError, type CostRecord } from "@app/rag-core";
import { createKajianQRouter, type RouterProvider } from "./chat-router";
import { ROUTER_FOLLOW_UP_RULE, ROUTER_SYSTEM_PROMPT } from "./chat-router-prompt";
import type { KajianQFilters } from "./filters";
import { GRADES, MADZHABS, TEXT_LAYERS } from "./filters";
import { INTENTS, SUBJECT_AREAS, SUB_QUERY_ROLES } from "./taxonomy";

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

type Captured = {
  turns: readonly { role: string; content: string }[];
  personalData: true;
  options: Record<string, unknown>;
};

type RouterQuery = {
  text: string;
  filters?: KajianQFilters;
  history?: readonly { role: string; content: string }[];
};

/** A reply, or a function of the call the provider receives — so a case can prove
 * the *prompt* carried what the reading depends on, not just a canned string. */
function harness(reply: string | ((spec: Captured) => string)): {
  route: (query: RouterQuery) => Promise<unknown>;
  captured: Captured[];
  events: TraceEvent[];
} {
  const captured: Captured[] = [];
  const events: TraceEvent[] = [];
  const provider: RouterProvider = {
    generate: (spec) => {
      captured.push(spec);
      return Effect.succeed({
        text: typeof reply === "function" ? reply(spec) : reply,
        cost: COST,
      });
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
    // Quran, Sunnah and Kitab. Madzhab and TextLayer stay classifications: the
    // corpus carries no row for their keys, so they are not filters. The reply's
    // retired `needsPrinciple`/`principleTags` hints are tolerated on the wire and
    // read as nothing — no principle field reaches the reading or the attributes.
    expect(routed.filters).toEqual({
      sourceType: ["quran", "hadith", "kitab"],
    });
    expect(routed.attributes).toMatchObject({
      category: "fikih",
      madzhab: "syafii",
      sourceType: ["quran", "hadith", "kitab"],
    });
    expect("needsPrinciple" in routed.attributes).toBe(false);
    expect("principleTags" in routed.attributes).toBe(false);
    // The caller's question keeps the `factual` slot, the reply's sanad entry
    // keeps its label, and the fired dalil rule fills the only slot no entry
    // covers — the reply's factual paraphrase is one angle inside a set that
    // now lands exactly on the ceiling.
    expect(routed.subQueries.map((s) => [s.role, s.origin])).toEqual([
      ["factual", "rule"],
      ["factual", "model"],
      ["sanad", "model"],
      ["dalil", "rule"],
    ]);
  });

  it("pins the call's sampling to the vendor's deterministic setting", async () => {
    const h = harness(REPLY);
    await h.route({ text: "Kenapa shalat orang sakit diringankan?" });
    // The reading decides source routing, so the call must not sample. Asserted as
    // the literal wire setting rather than through the constant that carries it: an
    // edit to the constant has to redden this test.
    expect(h.captured[0]?.options).toEqual({ temperature: 0 });
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

  it("degrades a reply part labelled with a retired role, keeping the part searchable", async () => {
    // A model that learned the old vocabulary can still send a role it no longer
    // declares. The label is dropped — never force-matched, never a filter of its
    // own — while the part's text stays in the fan-out, searched under the
    // category's own breadth. A stale label cannot invent a source the routing
    // table does not name.
    const h = harness(
      JSON.stringify({
        intent: "ruling",
        category: "hadith",
        subQueries: [{ text: "kaidah yusr dalam ibadah", role: "principle" }],
      }),
    );
    const routed = (await h.route({ text: "Apa kaidah kemudahan dalam ibadah?" })) as {
      filters: KajianQFilters;
      subQueries: readonly { text: string; role?: string; origin?: string }[];
    };

    // The union reads the set retrieval fans out over, not the reply's raw list —
    // the caller's question and the `hadith` category's own `sanad` rule included.
    expect(routed.subQueries.map((s) => [s.role, s.origin])).toEqual([
      ["factual", "rule"],
      [undefined, "model"],
      ["sanad", "rule"],
    ]);
    expect(routed.filters.sourceType).toEqual(["hadith"]);
    expect(h.events.at(-1)).toMatchObject({
      kind: "source_routing",
      detail: {
        sources: ["hadith"],
        filters: { sourceType: ["hadith"] },
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
          sources: ["quran", "hadith", "kitab"],
          // The record retrieval is handed, keyed as the store binds it — the
          // routing decision is on the trace, not only in the router's prose.
          // Only corpus-backed dimensions are here; the classifications ride the
          // intent event's attributes instead.
          filters: {
            sourceType: ["quran", "hadith", "kitab"],
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
      filters: { grade: ["sahih"] },
    })) as { filters: KajianQFilters; attributes: Record<string, unknown> };
    expect(routed.filters).toEqual({ grade: ["sahih"] });
    // The fallback applied those filters to retrieval, so the payload that says what
    // was understood carries them too — `{fallback: true}` alone would leave a trace
    // reader unable to tell what the route ran with.
    expect(routed.attributes).toEqual({ fallback: true, grade: ["sahih"] });
  });

  it("rejects a caller filter on a retired dimension on either arm, usable reply included", async () => {
    // The API edge for a dimension the corpus cannot satisfy is rejection as an
    // unknown dimension, not "ignore it and record a note": ignoring it would leave
    // the run executing a widened search while the trace claims the constraint ran —
    // the silent drop this change exists to remove. The usable-reply arm is the one
    // that regresses if the reader filters out caller keys instead of carrying them
    // to `filterEntries`.
    for (const dimension of ["madzhab", "textLayer", "principleTags"] as const) {
      for (const reply of [JSON.stringify({ not: "a reply" }), REPLY]) {
        const h = harness(reply);
        const filters = { [dimension]: ["x"] } as unknown as KajianQFilters;
        const error = await h.route({ text: "Apa hukum riba?", filters }).then(
          () => undefined,
          (cause: unknown) => cause,
        );
        expect(error, `${dimension} / ${reply.slice(0, 40)}`).toBeInstanceOf(StageError);
        expect((error as StageError).stage, dimension).toBe("router");
      }
    }
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

  it("keeps the caller's own entry when the reply echoes the question", async () => {
    // Reachable from the wire: `SubQueryReplySchema` accepts a bare string, so a cheap
    // reply can hand over exactly the question with no role. The caller's entry is
    // already in the set as the `factual` rule's text; the echo adds no duplicate and
    // the entry stays the rule's, never the model's (see chat-router-decompose.test.ts).
    const h = harness(JSON.stringify({ intent: "factual", subQueries: ["Apa hukum riba?"] }));
    const routed = (await h.route({ text: "Apa hukum riba?" })) as {
      subQueries: readonly { text: string; role?: string; origin?: string }[];
    };
    expect(routed.subQueries).toEqual([
      { text: "Apa hukum riba?", role: "factual", origin: "rule" },
    ]);
  });

  it("offers exactly the declared vocabularies in the prompt", () => {
    // The prompt *composes* its vocabulary lists from their owners (taxonomy, filters)
    // rather than re-spelling them, so a value cannot reach the reader unrequested.
    // This asserts the forward direction over every one of those lists.
    //
    // The reverse direction — a vocabulary value in the prompt that no list declares —
    // is not asserted here, and this loop cannot assert it: the prompt's one
    // hand-written line (the `subQueries` rules) names `factual`, `dalil`,
    // `sanad` and the two subject areas it keys on as prose. What ties those names to
    // their lists is the compiler, not this test: `chat-router-output.ts` names each
    // through the owner's own type, so renaming one there fails the build. A vocabulary
    // literal hand-written anywhere else would be this test's blind spot.
    for (const value of [
      ...INTENTS,
      ...SUBJECT_AREAS,
      ...SUB_QUERY_ROLES,
      ...MADZHABS,
      ...GRADES,
      ...TEXT_LAYERS,
    ]) {
      expect(ROUTER_SYSTEM_PROMPT, `prompt is missing "${value}"`).toContain(value);
    }
  });

  /**
   * Follow-up routing. The failure these pin: a short question that names its
   * topic only by reference was routed from its own words alone, so retrieval
   * missed the topic the previous turn established and the generator's citation
   * of it was refused as ungrounded. The prior turns must travel with the call,
   * and the window must be bounded and recorded.
   */

  it("sends a single-turn question the unchanged prompt and records no window", async () => {
    const h = harness(REPLY);
    const routed = (await h.route({ text: "Apa hukum riba?" })) as {
      attributes: Record<string, unknown>;
    };

    // Byte for byte the call a single-turn question always made: the base prompt,
    // then the question. The follow-up rule is appended only when there are
    // earlier turns, so this path is not re-opened by the multi-turn change.
    expect(h.captured[0]?.turns).toEqual([
      { role: "system", content: ROUTER_SYSTEM_PROMPT },
      { role: "user", content: "Apa hukum riba?" },
    ]);
    // Absent means "no prior turns", so a single-turn trace keeps the shape it
    // always had.
    expect(routed.attributes["historyTurns"]).toBeUndefined();
  });

  it("carries the session's prior turns on a follow-up call and records the window", async () => {
    const h = harness(REPLY);
    const routed = (await h.route({
      text: "Apa dalilnya?",
      history: [
        { role: "user", content: "Apa itu Ayat Kursi?" },
        { role: "assistant", content: "Ayat Kursi adalah QS. 2:255." },
      ],
    })) as { attributes: Record<string, unknown> };

    const turns = h.captured[0]?.turns ?? [];
    // Oldest first, between the system prompt and the caller's verbatim question.
    expect(turns.slice(1, -1)).toEqual([
      { role: "user", content: "Apa itu Ayat Kursi?" },
      { role: "assistant", content: "Ayat Kursi adalah QS. 2:255." },
    ]);
    expect(turns[0]?.content).toBe(`${ROUTER_SYSTEM_PROMPT}\n${ROUTER_FOLLOW_UP_RULE}`);
    expect(turns.at(-1)).toEqual({ role: "user", content: "Apa dalilnya?" });
    // The window the call actually carried is trace content (the runner stamps
    // `attributes` onto the `intent` event), so a follow-up answer's evidence is
    // auditable: how many prior turns the router carried, and which sub-queries it ran.
    expect(routed.attributes["historyTurns"]).toBe(2);
  });

  it("bounds the history a caller can push into the router prompt", async () => {
    const h = harness(REPLY);
    const history = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `turn ${index}`,
    }));
    const routed = (await h.route({ text: "Apa dalilnya?", history })) as {
      attributes: Record<string, unknown>;
    };

    // The tail is the useful part for an anaphor, and the bound is what keeps the
    // call's input independent of how long the session has run.
    expect(h.captured[0]?.turns.slice(1, -1).map((t) => t.content)).toEqual([
      "turn 6",
      "turn 7",
      "turn 8",
      "turn 9",
    ]);
    expect(routed.attributes["historyTurns"]).toBe(4);
  });

  it("resolves a short anaphoric follow-up into sub-queries about the prior topic", async () => {
    // The reading a real router gives when the prompt carries the earlier turn:
    // the topic is taken from what it was told, not from the follow-up's words.
    const reply = (spec: Captured): string => {
      const prior = spec.turns
        .slice(1, -1)
        .filter((t) => t.role === "user")
        .at(-1)?.content;
      return JSON.stringify({
        intent: "factual",
        category: "hadith",
        subQueries:
          prior === undefined
            ? ["Apa dalilnya?"]
            : [{ text: "dalil tentang ayat kursi", role: "sanad" }],
      });
    };
    const followUp = {
      text: "Apa dalilnya?",
      history: [
        { role: "user", content: "Apa itu Ayat Kursi?" },
        { role: "assistant", content: "Ayat Kursi adalah QS. 2:255." },
      ],
    };
    const withHistory = harness(reply);
    const routed = (await withHistory.route(followUp)) as {
      subQueries: { text: string; role?: string; origin?: string }[];
    };

    // The retrieval set carries the prior topic — what the follow-up refers to —
    // and the caller's verbatim follow-up still leads the set as its own factual
    // entry: history resolves the sub-queries, it never rewrites `sourceText`.
    expect(routed.subQueries.map((sub) => sub.text)).toContain("dalil tentang ayat kursi");
    expect(routed.subQueries[0]).toEqual({
      text: "Apa dalilnya?",
      role: "factual",
      origin: "rule",
    });

    // Control: the same provider and question with no history. Nothing in the
    // call names a prior topic, so the reading repeats the follow-up's own words
    // and the fired `sanad` template can only embed those words too — a route
    // whose retrieval text names only the follow-up's own words.
    const withoutHistory = harness(reply);
    const single = (await withoutHistory.route({ text: followUp.text })) as {
      subQueries: { text: string }[];
    };
    const singleTexts = single.subQueries.map((sub) => sub.text);
    expect(singleTexts.some((text) => text.includes("ayat kursi"))).toBe(false);
    expect(singleTexts).toContain("Apa dalilnya?");
  });

  it("keeps a self-contained short question's own topic when prior turns ride the call", async () => {
    // The rule's other arm: the question stands on its own, so the earlier turns
    // are context the model is told to ignore. The stage never folds a prior turn
    // into a sub-query itself, so nothing from them reaches the retrieval set.
    const h = harness(
      JSON.stringify({
        intent: "ruling",
        category: "fikih",
        subQueries: [{ text: "hukum riba dalam muamalah", role: "factual" }],
      }),
    );
    const routed = (await h.route({
      text: "Apa hukum riba?",
      history: [
        { role: "user", content: "Apa itu Ayat Kursi?" },
        { role: "assistant", content: "Ayat Kursi adalah QS. 2:255." },
      ],
    })) as { subQueries: { text: string; role?: string; origin?: string }[] };

    // Both arms ride the call, so the model is told which one applies.
    expect(h.captured[0]?.turns[0]?.content).toContain(
      "If the question is understandable on its own, ignore the earlier turns",
    );
    const texts = routed.subQueries.map((sub) => sub.text);
    // The question's own topic is a retrieval angle — and the earlier topic is not.
    expect(texts).toContain("hukum riba dalam muamalah");
    expect(texts).toContain("Apa hukum riba?");
    expect(texts.some((text) => text.includes("ayat kursi"))).toBe(false);
  });

  it("records the window when the reply is unusable, and asks nothing for a content-free text", async () => {
    const history = [
      { role: "user", content: "Apa itu Ayat Kursi?" },
      { role: "assistant", content: "Ayat Kursi adalah QS. 2:255." },
    ];

    const unusable = harness("I cannot answer that.");
    const routed = (await unusable.route({ text: "Apa dalilnya?", history })) as {
      attributes: Record<string, unknown>;
    };
    // The call still happened and still cost money, so the fallback route records
    // that it was given prior turns even though it could not use the reply.
    expect(routed.attributes).toMatchObject({ fallback: true, historyTurns: 2 });

    // A content-free text is gated before any call: there is no model turn to
    // carry history into, so the window is not part of that route.
    const gated = harness("I cannot answer that.");
    const empty = (await gated.route({ text: "!!", history })) as {
      attributes: Record<string, unknown>;
    };
    expect(gated.captured).toEqual([]);
    expect(empty.attributes).toEqual({ fallback: true, contentFree: true });
  });
});
