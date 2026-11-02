import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { runChatPipeline } from "./chat-pipeline";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";
import { withDistanceFloor } from "./test-utils/distance-floor";
import { createStubChatProviders } from "./test-utils/stub-chat-providers";

/**
 * INTEGRATION TEST — a same-session follow-up on the path the WIRING runs.
 *
 * The trust invariant: a follow-up answer's citations are grounded in evidence
 * this run retrieved, never in what an earlier turn said. The prior turns are
 * allowed to do two things — resolve the follow-up's anaphor into retrieval
 * sub-queries about the prior topic, and ride the generator's prompt as a
 * labelled reference of the caller's own earlier questions — and the citation
 * gate is untouched: the same draft that is answered when the resolved sub-query
 * finds the passage is refused as `ungrounded_citation` when it does not, and an
 * earlier answer's citation label is never prompt content at all.
 *
 * Asserted through `runChatPipeline` (the same `buildChatStages` wiring
 * production uses, ADR-0021) over the real retriever and store, so a router that
 * drops the history, a runner that fails to stamp it, or a gate that somehow
 * accepts the earlier answer's citation all redden here.
 */

const CITATION = "HR. Bukhari no. 52 (Sahih)";
const TOPIC = "menuntut ilmu";
const ARABIC = "طَلَبُ الْعِلْمِ فَرِيدَةٌ";
const TRANSLATION = "Menuntut ilmu itu kewajiban.";
const HADITH_VEC = [1, 0, 0];
const OTHER_VEC = [0, 1, 0];

/**
 * The retrieval policy this case asserts: the topic-bearing query reaches the
 * seeded hadith and the follow-up's bare words do not. The memory stand-in
 * returns every seeded row to every search, so the window is declared here.
 */
const MAX_DISTANCE = 0.5;

/** The session's prior turn pair: the topic the follow-up refers back to. */
const HISTORY = [
  { role: "user", content: "Sebutkan hadis tentang menuntut ilmu!" },
  { role: "assistant", content: `Menuntut ilmu itu kewajiban [${CITATION}].` },
];

/** The draft under test: it cites the hadith by its corpus label. */
const DRAFT = `Menuntut ilmu itu kewajiban bagi setiap muslim [${CITATION}].`;

async function seedHadith(
  store: ReturnType<typeof createMemoryRagStore>,
  options: {
    citation?: string;
    vector?: readonly number[];
    textAr?: string;
    textId?: string;
  } = {},
): Promise<string> {
  const {
    citation = CITATION,
    vector = HADITH_VEC,
    textAr = ARABIC,
    textId = TRANSLATION,
  } = options;
  const parentId = await Effect.runPromise(
    store.insertDocParent({
      sourceKey: "hadith/bukhari",
      title: "Sahih al-Bukhari",
      metadata: {},
    }),
  );
  return Effect.runPromise(
    store.insertDocChild({
      parentId,
      textRaw: textAr,
      textAr,
      textId,
      citation: { sourceType: "hadith" },
      embeddingPrimary: [...vector],
      embeddingFallback: [...vector],
      ordinal: 0,
      metadata: {
        sourceType: "hadith",
        collection: "bukhari",
        hadithNo: "52",
        grade: "sahih",
        citation,
      },
    }),
  );
}

type RouterReply = (turns: readonly { role: string; content: string }[]) => string;

/**
 * The reading a real router gives with the prior turns in its prompt: the
 * follow-up's own words name no topic, so the topic comes from the history the
 * prompt carried. Without it, the reading repeats the follow-up only.
 */
const topicAwareRouter: RouterReply = (turns) => {
  const prior = turns
    .slice(1, -1)
    .map((turn) => turn.content)
    .join("\n");
  const current = turns.at(-1)?.content ?? "";
  const topicKnown = prior.includes(TOPIC) || current.includes(TOPIC);
  return JSON.stringify({
    intent: "factual",
    category: "hadith",
    subQueries: [
      topicKnown
        ? { text: `hadis ${TOPIC}`, role: "sanad" }
        : { text: "Jelaskan hadits itu.", role: "sanad" },
    ],
  });
};

type RunOptions = {
  /** The draft the generator returns (default {@link DRAFT}). */
  answerText?: string;
  /** The router's reading (default {@link topicAwareRouter}). */
  routerReply?: RouterReply;
};

/** The deps as the composition root builds them, with the retrieval made a
 * function of the query text so a sub-query's wording decides what it reaches. */
function pipelineFor(store: ReturnType<typeof createMemoryRagStore>, options: RunOptions = {}) {
  const stubs = createStubChatProviders({
    answerText: options.answerText ?? DRAFT,
    embedFor: (text) => (text.includes(TOPIC) ? HADITH_VEC : OTHER_VEC),
    routerReply: options.routerReply ?? topicAwareRouter,
  });
  const deps = {
    ...stubs,
    store,
    bridge: (effect: never) => Effect.runPromise(effect),
    language: "id",
    retrieval: {},
  } as never;
  return { deps, generatorCalls: stubs.generatorCalls };
}

type Answer = {
  text: string;
  trace: {
    events: {
      kind: string;
      detail?: Record<string, unknown>;
    }[];
  };
  /** Every generator prompt this run sent, in call order. */
  generatorCalls: readonly (readonly { role: string; content: string }[])[];
};

async function answerFor(
  store: ReturnType<typeof createMemoryRagStore>,
  query: { text: string; history?: readonly { role: string; content: string }[] },
  options: RunOptions = {},
): Promise<Answer> {
  const { deps, generatorCalls } = pipelineFor(store, options);
  const answer = (await Effect.runPromise(
    runChatPipeline(deps, query, {}, { now: () => 7 }) as never,
  )) as Omit<Answer, "generatorCalls">;
  return { ...answer, generatorCalls };
}

/** The text the prompt prints as citable, under its evidence header. */
function citableText(prompt: string): string {
  const at = prompt.indexOf("Konteks / Context:");
  return at === -1 ? "" : prompt.slice(at);
}

function promptOf(answer: Answer, call = 0): string {
  return (answer.generatorCalls[call] ?? []).map((turn) => turn.content).join("\n");
}

function intentAttributes(answer: Answer): Record<string, unknown> | undefined {
  const intent = answer.trace.events.find((event) => event.kind === "intent");
  return intent?.detail?.["attributes"] as Record<string, unknown> | undefined;
}

function subQueriesOf(answer: Answer): string[] {
  return answer.trace.events
    .filter((event) => event.kind === "subquery")
    .map((event) => String(event.detail?.["text"] ?? ""));
}

function retrievedIds(answer: Answer): string[] {
  const retrieval = answer.trace.events.find((event) => event.kind === "retrieval");
  const chunks = (retrieval?.detail?.["chunks"] ?? []) as { id: string }[];
  return chunks.map((chunk) => chunk.id);
}

function refusalTrigger(answer: Answer): unknown {
  return answer.trace.events.find((event) => event.kind === "refusal")?.detail?.["trigger"];
}

/** The assembler boundary's turn count: the reference (when any) plus the evidence. */
function turnCountOf(answer: Answer): unknown {
  return answer.trace.events.find((event) => event.kind === "assembly")?.detail?.["turnCount"];
}

describe("a same-session follow-up retrieves from the prior turn's topic", () => {
  it("answers with a grounded citation when the follow-up resolves to the prior topic", async () => {
    const store = createMemoryRagStore();
    const chunkId = await seedHadith(store);
    const answer = await answerFor(withDistanceFloor(store, MAX_DISTANCE), {
      text: "Jelaskan hadits itu.",
      history: HISTORY,
    });

    // The draft was not replaced: the citation is grounded in the evidence this
    // run retrieved, not in the citation the earlier turn carried.
    expect(answer.text).toContain(CITATION);
    expect(refusalTrigger(answer)).toBeUndefined();

    // The retrieval sub-query carries the prior topic, beside the caller's own
    // verbatim words — which are never rewritten from history.
    const subQueries = subQueriesOf(answer);
    expect(subQueries).toContain(`hadis ${TOPIC}`);
    expect(subQueries).toContain("Jelaskan hadits itu.");

    // ... and the topic-bearing sub-query is what reached the passage.
    expect(retrievedIds(answer)).toContain(chunkId);

    // What history was used is trace content: the intent event records the window
    // the router call actually carried, so the evidence path is auditable.
    expect(intentAttributes(answer)?.["historyTurns"]).toBe(HISTORY.length);
  });

  it("still refuses the same draft when no prior turn carries the topic", async () => {
    const store = createMemoryRagStore();
    await seedHadith(store);
    // Same question, same draft, no history: nothing names the topic, nothing
    // retrieves the hadith, and the citation gate refuses exactly as before. The
    // fix adds retrieval evidence; it never licenses the earlier turn's citation.
    const answer = await answerFor(withDistanceFloor(store, MAX_DISTANCE), {
      text: "Jelaskan hadits itu.",
    });

    expect(answer.text).not.toContain(CITATION);
    expect(refusalTrigger(answer)).toBe("ungrounded_citation");
    expect(intentAttributes(answer)?.["historyTurns"]).toBeUndefined();
    // Nothing rode the prompt as a reference: the assembled context is the evidence turn.
    expect(turnCountOf(answer)).toBe(1);
  });

  it("does not treat an earlier assistant answer as evidence", async () => {
    const store = createMemoryRagStore();
    const chunkId = await seedHadith(store);
    // The prior turn cites the hadith, but retrieval is given a window that no
    // query can reach: the earlier answer's citation must not ground the draft.
    const answer = await answerFor(withDistanceFloor(store, -1), {
      text: "Jelaskan hadits itu.",
      history: HISTORY,
    });

    expect(retrievedIds(answer)).not.toContain(chunkId);
    expect(refusalTrigger(answer)).toBe("ungrounded_citation");
    // The window is still recorded: the call carried history even though the
    // evidence it could reach was empty.
    expect(intentAttributes(answer)?.["historyTurns"]).toBe(HISTORY.length);
  });
});

/**
 * **An earlier answer's citation label never reaches the generator as citable
 * text.**
 *
 * The earlier answer is where a copied label comes from: presented beside the
 * evidence, it invites a draft that names a label this run's retrieval does not
 * hold, and the citation gate then refuses an answer the prompt itself provoked.
 * The earlier QUESTION may still ride the prompt as a labelled reference, so a
 * follow-up's anaphor keeps its topic, but the citable section is this run's
 * evidence and the gate still refuses the stale label.
 */
const STALE_CITATION = "HR. Ibn Majah no. 224";
const STALE_ANSWER = `Menuntut ilmu itu kewajiban [${STALE_CITATION}].`;
const STALE_DRAFT = `Menuntut ilmu itu kewajiban bagi setiap muslim [${STALE_CITATION}].`;
const CURRENT_CITATION = "HR. Ibn Majah no. 100 (Sahih)";
const CURRENT_DRAFT = `Menuntut ilmu itu kewajiban bagi setiap muslim [${CURRENT_CITATION}].`;
/** The prior turn pair: the answer cites a label this run's retrieval lacks. */
const STALE_HISTORY = [
  { role: "user", content: "Apa hadits tentang menuntut ilmu?" },
  { role: "assistant", content: STALE_ANSWER },
];

describe("the generator's prompt carries this run's evidence, never the earlier answer", () => {
  it("keeps the earlier answer's label out of the prompt and answers from this run's retrieval", async () => {
    const store = createMemoryRagStore();
    const chunkId = await seedHadith(store, { citation: CURRENT_CITATION });
    const answer = await answerFor(
      withDistanceFloor(store, MAX_DISTANCE),
      { text: "Jelaskan hadits itu.", history: STALE_HISTORY },
      { answerText: CURRENT_DRAFT },
    );

    // The bytes the provider was sent never print the earlier answer's label,
    // and the citable section prints only this run's evidence.
    const prompt = promptOf(answer);
    expect(prompt).not.toContain("no. 224");
    expect(citableText(prompt)).not.toContain("no. 224");
    expect(citableText(prompt)).toContain(CURRENT_CITATION);

    // The retrieved label is cited and the answer ships: no refusal.
    expect(retrievedIds(answer)).toContain(chunkId);
    expect(answer.text).toContain(CURRENT_CITATION);
    expect(refusalTrigger(answer)).toBeUndefined();

    // The trace shows the reference riding its own turn ahead of the evidence: the
    // assembly boundary counts the pair's question and this run's evidence, never
    // the pair's answer as a third turn.
    expect(turnCountOf(answer)).toBe(2);
  });

  it("still refuses a draft that cites the earlier answer's label", async () => {
    const store = createMemoryRagStore();
    await seedHadith(store, { citation: CURRENT_CITATION });
    // Same prompt discipline, a draft that names the label it no longer sees:
    // the gate grounds citations in this run's retrieval, and nothing else.
    const answer = await answerFor(
      withDistanceFloor(store, MAX_DISTANCE),
      { text: "Jelaskan hadits itu.", history: STALE_HISTORY },
      { answerText: STALE_DRAFT },
    );

    expect(answer.text).not.toContain(STALE_CITATION);
    expect(refusalTrigger(answer)).toBe("ungrounded_citation");
  });

  it("keeps a self-contained mid-session question on its own topic", async () => {
    const store = createMemoryRagStore();
    const ribaCitation = "HR. Bukhari no. 7 (Sahih)";
    const chunkId = await seedHadith(store, {
      citation: ribaCitation,
      vector: OTHER_VEC,
      textAr: "الرِّبَا حَرَامٌ",
      textId: "Riba itu haram.",
    });
    const answer = await answerFor(
      withDistanceFloor(store, MAX_DISTANCE),
      { text: "Apa hukum riba?", history: STALE_HISTORY },
      {
        answerText: `Riba itu haram [${ribaCitation}].`,
        // A question that stands on its own is routed from its own words.
        routerReply: () =>
          JSON.stringify({
            intent: "ruling",
            category: "fikih",
            subQueries: [{ text: "hukum riba", role: "dalil" }],
          }),
      },
    );

    // The evidence section is this question's topic: the earlier pair's topic
    // and its label are not citable material for it.
    const citable = citableText(promptOf(answer));
    expect(citable).not.toContain(TOPIC);
    expect(citable).not.toContain(STALE_CITATION);
    expect(citable).toContain(ribaCitation);

    expect(retrievedIds(answer)).toContain(chunkId);
    expect(answer.text).toContain(ribaCitation);
    expect(refusalTrigger(answer)).toBeUndefined();
  });
});
