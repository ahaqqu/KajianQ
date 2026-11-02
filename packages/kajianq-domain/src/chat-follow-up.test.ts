import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { runChatPipeline, type ChatPipelineDeps } from "./chat-pipeline";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";
import { withDistanceFloor } from "./test-utils/distance-floor";
import { createStubChatProviders } from "./test-utils/stub-chat-providers";

/**
 * INTEGRATION TEST — a same-session follow-up on the path the WIRING runs.
 *
 * The trust invariant: a follow-up answer's citations are grounded in evidence
 * this run retrieved, never in what an earlier turn said. The prior turns are
 * allowed to do exactly one thing — resolve the follow-up's anaphor into
 * retrieval sub-queries about the prior topic — and the citation gate is
 * untouched: the same draft that is answered when the resolved sub-query finds
 * the passage is refused as `ungrounded_citation` when it does not.
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

async function seedHadith(store: ReturnType<typeof createMemoryRagStore>): Promise<string> {
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
      textRaw: ARABIC,
      textAr: ARABIC,
      textId: TRANSLATION,
      citation: { sourceType: "hadith" },
      embeddingPrimary: HADITH_VEC,
      embeddingFallback: HADITH_VEC,
      ordinal: 0,
      metadata: {
        sourceType: "hadith",
        collection: "bukhari",
        hadithNo: "52",
        grade: "sahih",
        citation: CITATION,
      },
    }),
  );
}

/** The deps as the composition root builds them, with the retrieval made a
 * function of the query text so a sub-query's wording decides what it reaches. */
function depsFor(store: ReturnType<typeof createMemoryRagStore>): ChatPipelineDeps {
  return {
    ...createStubChatProviders({
      answerText: DRAFT,
      embedFor: (text) => (text.includes(TOPIC) ? HADITH_VEC : OTHER_VEC),
      // The reading a real router gives with the prior turns in its prompt: the
      // follow-up's own words name no topic, so the topic comes from the history
      // the prompt carried. Without it, the reading repeats the follow-up only.
      routerReply: (turns) => {
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
      },
    }),
    store,
    bridge: (effect: never) => Effect.runPromise(effect),
  } as never;
}

type Answer = {
  text: string;
  trace: {
    events: {
      kind: string;
      detail?: Record<string, unknown>;
    }[];
  };
};

async function answerFor(
  store: ReturnType<typeof createMemoryRagStore>,
  query: { text: string; history?: readonly { role: string; content: string }[] },
): Promise<Answer> {
  return Effect.runPromise(
    runChatPipeline(depsFor(store), query, {}, { now: () => 7 }) as never,
  ) as Promise<Answer>;
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

describe("a same-session follow-up retrieves from the prior turn's topic", () => {
  it("answers with a grounded citation when the follow-up resolves to the prior topic", async () => {
    const store = createMemoryRagStore();
    const chunkId = await seedHadith(store);
    const answer = await answerFor(withDistanceFloor(store, MAX_DISTANCE), {
      text: "Jelaskan hadits itu.",
      history: HISTORY,
    });

    // The draft was not replaced: the citation is grounded in the evidence this
    // run retrieved. That is the property the ticket's refusal was missing.
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
