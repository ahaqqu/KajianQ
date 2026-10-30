import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_NEIGHBOUR_CAP,
  DEFAULT_NEIGHBOUR_RADIUS,
  runChatPipelinePromise,
  runStoreEffect,
  surahSourceKey,
  type ChatPipelineDeps,
} from "@app/kajianq-domain";
import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";
import { createStubChatProviders } from "@app/kajianq-domain/test-utils/stub-chat-providers";
import { buildChatWiring, ChatConfigError } from "./chat-wiring";

/**
 * INTEGRATION TEST — every retriever tunable the pipeline deps carry is driven through
 * the real serving composition root (`buildChatWiring` → `buildChatStages` →
 * `createChatRetriever`) and asserted where it acts: the bounded store read's options,
 * the typed expansion event, or the assembled evidence the generator is shown — never on
 * the deps object's shape.
 *
 * The probe table below is keyed by `ChatPipelineDeps["retrieval"]`, so a tunable the
 * retriever gains does not compile here until it has a binding (or a stated reason it has
 * none) and an assertion that its configured value reaches the arm it feeds. A deps object
 * carrying a key no stage reads is precisely the failure this catches: it looks
 * configured and widens nothing.
 */

const KEYED_ENV = { DATABASE_URL: "postgres://x", DEEPSEEK_API_KEY: "k" };

/** A question naming no surah and no citation label: only the neighbour arm runs. */
const PLAIN_QUESTION = "Apa yang dimaksud dengan ayat yang agung?";

/** A question naming the seeded verse: the scope, citation and neighbour arms all run, so
 * a probe can tell which arm a knob reached. */
const CITED_QUESTION = "Apa yang dimaksud dengan QS. 2:255?";

/** The stub embedder's query vector: the one verse seeded with it is the fused hit. */
const HIT_VEC = [1, 0, 0];

type Store = ReturnType<typeof createMemoryRagStore>;

/**
 * Seed Al-Baqarah with a single embedded verse (2:255). Every other verse is stored
 * without an embedding, so the fused search returns the anchor alone and every other
 * verse in the context arrived through an expansion under test. 286 verses exceed the
 * scope read's budget, so no surah completion competes with it.
 */
async function seedSurah(store: Store): Promise<void> {
  const parentId = await runStoreEffect(
    store.insertDocParent({
      sourceKey: surahSourceKey(2),
      title: "QS. 2",
      metadata: { sourceType: "quran", surah: 2 },
    }),
  );
  await runStoreEffect(
    store.insertDocChildren(
      Array.from({ length: 286 }, (_, ordinal) => {
        const ayah = ordinal + 1;
        return {
          parentId,
          textRaw: `ar-2:${ayah}`,
          textAr: `ar-2:${ayah}`,
          textId: `id-2:${ayah}`,
          citation: { sourceType: "quran", surah: 2, ayah },
          embeddingPrimary: ayah === 255 ? HIT_VEC : null,
          embeddingFallback: null,
          ordinal,
          metadata: { sourceType: "quran", surah: 2, ayah, citation: `QS. 2:${ayah}` },
        };
      }),
    ),
  );
}

/**
 * Seed one hadith with two chains that disagree — the child the per-chain evidence
 * arm reads. It rides the same embedding as the verse so it is always retrieved, and
 * its stored rows are what a chain knob's effect is observed on.
 */
async function seedChainedHadith(store: Store): Promise<{ childId: string }> {
  const parentId = await runStoreEffect(
    store.insertDocParent({
      sourceKey: "hadith:contract-fixture",
      title: "HR. Bukhari",
      metadata: { sourceType: "hadith" },
    }),
  );
  const childId = await runStoreEffect(
    store.insertDocChild({
      parentId,
      textRaw: "حدثنا",
      textAr: "حدثنا",
      textId: null,
      citation: { sourceType: "hadith", collection: "bukhari", hadithNo: 1 },
      embeddingPrimary: HIT_VEC,
      embeddingFallback: null,
      ordinal: 0,
      metadata: {
        sourceType: "hadith",
        collection: "bukhari",
        grade: "sahih",
        citation: "HR. Bukhari no. 1 (Sahih)",
      },
    }),
  );
  store.seedNarrator({
    id: NARRATOR_ONE,
    canonicalNameAr: "نافع",
    nameVariants: [],
    kunya: null,
    laqab: null,
    deathYear: null,
    tabaqa: null,
    reliabilityByCritic: { "yahya-ibn-said": { verdict: "thiqa", sourceRef: "tahdzib-1" } },
    metadata: {},
  });
  store.seedNarrator({
    id: NARRATOR_TWO,
    canonicalNameAr: "ابن عمر",
    nameVariants: [],
    kunya: null,
    laqab: null,
    deathYear: null,
    tabaqa: null,
    reliabilityByCritic: {},
    metadata: {},
  });
  store.seedChain({
    id: "33333333-3333-4333-8333-333333333331",
    childId,
    collection: "bukhari",
    narratorIds: [NARRATOR_ONE, NARRATOR_TWO],
    grade: "sahih",
    grader: "al-bukhari",
    sourceRef: null,
    seq: 1,
  });
  store.seedChain({
    id: "33333333-3333-4333-8333-333333333332",
    childId,
    collection: "bukhari",
    narratorIds: [NARRATOR_ONE],
    grade: "dhaif",
    grader: "al-daraqutni",
    sourceRef: null,
    seq: 2,
  });
  return { childId };
}

const NARRATOR_ONE = "11111111-1111-4111-8111-111111111101";
const NARRATOR_TWO = "22222222-2222-4222-8222-222222222202";

/** The fused hit every configuration holds: the expansion's anchor, always in context. */
const ANCHOR = "QS. 2:255";

/** The verses the assembled context puts in front of the generator, beyond the anchor. */
function neighbourCitationsIn(context: string): string[] {
  return [...context.matchAll(/\[(QS\. 2:\d+)\]/g)]
    .map((match) => match[1] as string)
    .filter((citation) => citation !== ANCHOR)
    .sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]));
}

type Run = {
  /** Every similarity read the two tracks issued, with the depth it asked for. */
  searches: { limit: number }[];
  /** Every bounded surah read the scope arm issued, with the budget it was given. */
  scopeReads: { limit: number }[];
  /** Every exact-label read the citation arm issued, with the budget it was given. */
  citationReads: { limit: number }[];
  /** Every bounded neighbourhood read the retriever issued, with its options. */
  neighbourReads: { anchors: readonly string[]; radius: number; limit: number }[];
  /** Every per-child chain read the evidence arm issued, with its bound. */
  chainReads: { childId: string; limit: number }[];
  /** The typed chain-evidence record, when the arm ran. */
  chainEvidence:
    | { consulted: number; perChildCap: number; notConsulted: readonly string[] }
    | undefined;
  /** The assembled context the generator was shown. */
  context: string;
  /** The cap each typed scope event recorded. */
  scopeCaps: number[];
  /** The cap the typed citation event recorded, when the arm ran. */
  citationCap: number | undefined;
  /** The caller-priority guarantee's typed event, when the caller arm ran: the bound
   * the run applied and the ids it promoted. */
  callerPriority: { k: number; ids: readonly string[] } | undefined;
  /** The typed neighbourhood event, when the expansion ran. */
  detail:
    | {
        anchors: readonly string[];
        returned: number;
        radius: number;
        cap: number;
        truncated: boolean;
      }
    | undefined;
};

/**
 * The serving wiring with its provider seams replaced by the domain's stubs and its
 * store by a seeded memory store that records every bounded read. Everything else — the
 * knobs included — is `buildChatWiring`'s own.
 */
async function runWith(
  env: Record<string, string | undefined>,
  question: string = PLAIN_QUESTION,
): Promise<Run> {
  const store = createMemoryRagStore();
  await seedSurah(store);
  await seedChainedHadith(store);
  const searches: Run["searches"] = [];
  const scopeReads: Run["scopeReads"] = [];
  const citationReads: Run["citationReads"] = [];
  const neighbourReads: Run["neighbourReads"] = [];
  const chainReads: Run["chainReads"] = [];
  const storeSpy: Store = {
    ...store,
    similaritySearch(track, vector, opts) {
      searches.push({ limit: opts.limit });
      return store.similaritySearch(track, vector, opts);
    },
    listDocChildrenByParentSourceKey(parentSourceKey, opts) {
      scopeReads.push({ limit: opts.limit });
      return store.listDocChildrenByParentSourceKey(parentSourceKey, opts);
    },
    findDocChildrenByMetadata(match, opts) {
      citationReads.push({ limit: opts.limit });
      return store.findDocChildrenByMetadata(match, opts);
    },
    listDocChildNeighboursByChildIds(anchors, opts) {
      neighbourReads.push({ anchors: [...anchors], radius: opts.radius, limit: opts.limit });
      return store.listDocChildNeighboursByChildIds(anchors, opts);
    },
    listChainsForChild(childId, opts) {
      chainReads.push({ childId, limit: opts.limit });
      return store.listChainsForChild(childId, opts);
    },
  };
  const stub = createStubChatProviders({
    noStream: true,
    answerText: "Jawaban QS. 2:254: ayat yang agung.",
  });
  const turns: { role: string; content: string }[][] = [];
  const deps: ChatPipelineDeps = {
    ...buildChatWiring({ ...KEYED_ENV, ...env }).pipeline,
    routerProvider: stub.routerProvider,
    generatorProvider: {
      generate: (spec) => {
        turns.push([...spec.turns]);
        return stub.generatorProvider.generate(spec);
      },
    },
    reviewerProvider: stub.reviewerProvider,
    reviewerDecider: stub.reviewerDecider,
    embedder: stub.embedder,
    store: storeSpy,
    bridge: runStoreEffect,
    language: "id",
  };
  const answer = await runChatPipelinePromise(deps, { text: question });
  const userTurn = turns[0]?.find((turn) => turn.role === "user")?.content;
  if (userTurn === undefined) throw new Error("the generator was never shown a context");
  const event = answer.trace.events.find((entry) => entry.kind === "neighbour_expansion");
  const callerEvent = answer.trace.events.find((entry) => entry.kind === "caller_priority");
  const chainEvent = answer.trace.events.find((entry) => entry.kind === "chain_evidence");
  return {
    searches,
    scopeReads,
    citationReads,
    neighbourReads,
    chainReads,
    chainEvidence:
      chainEvent === undefined
        ? undefined
        : {
            consulted: chainEvent.detail.consulted,
            perChildCap: chainEvent.detail.perChildCap,
            notConsulted: chainEvent.detail.notConsulted ?? [],
          },
    context: userTurn,
    scopeCaps: answer.trace.events
      .filter((entry) => entry.kind === "scope_expansion")
      .map((entry) => entry.detail.cap),
    citationCap: answer.trace.events.find((entry) => entry.kind === "citation_lookup")?.detail.cap,
    callerPriority:
      callerEvent === undefined
        ? undefined
        : { k: callerEvent.detail.k, ids: [...callerEvent.detail.ids] },
    detail:
      event === undefined ? undefined : { ...event.detail, anchors: [...event.detail.anchors] },
  };
}

describe("buildChatWiring — the configured neighbourhood window reaches the retriever", () => {
  it("applies the configured radius to the read and to the context", async () => {
    const run = await runWith({ NEIGHBOUR_EXPANSION_RADIUS: "3" });

    // The retriever's own bounded read carries the operator's radius...
    expect(run.neighbourReads).toHaveLength(1);
    expect(run.neighbourReads[0]?.radius).toBe(3);
    // ...so three ordinals on each side of 2:255 reach the generator, not one.
    expect(run.detail).toMatchObject({ radius: 3, cap: DEFAULT_NEIGHBOUR_CAP, returned: 6 });
    expect(neighbourCitationsIn(run.context)).toEqual([
      "QS. 2:252",
      "QS. 2:253",
      "QS. 2:254",
      "QS. 2:256",
      "QS. 2:257",
      "QS. 2:258",
    ]);
  });

  it("applies the configured cap to the read and to the context", async () => {
    const run = await runWith({ NEIGHBOUR_EXPANSION_RADIUS: "3", NEIGHBOUR_EXPANSION_CAP: "2" });

    // The cap bounds what reaches the context; the read asks for cap + one slot per
    // row already in context (the verse anchor and the chained hadith) + one proof row.
    // The read answers in the store's order — the anchor's window by ascending ordinal
    // — so the cap keeps the window's first rows.
    expect(run.neighbourReads[0]).toMatchObject({ radius: 3, limit: 2 + 2 + 1 });
    expect(run.detail).toMatchObject({ radius: 3, cap: 2, returned: 2, truncated: true });
    expect(neighbourCitationsIn(run.context)).toEqual(["QS. 2:252", "QS. 2:253"]);
  });

  it("keeps the retriever's own defaults when an operator configures nothing", async () => {
    const unset = await runWith({});

    // Unset = the retriever's documented defaults: one ordinal each side, twelve chunks
    // at most.
    expect(unset.neighbourReads[0]).toMatchObject({
      radius: DEFAULT_NEIGHBOUR_RADIUS,
      limit: DEFAULT_NEIGHBOUR_CAP + 2 + 1,
    });
    expect(unset.detail).toMatchObject({
      radius: DEFAULT_NEIGHBOUR_RADIUS,
      cap: DEFAULT_NEIGHBOUR_CAP,
      returned: 2,
      truncated: false,
    });
    expect(neighbourCitationsIn(unset.context)).toEqual(["QS. 2:254", "QS. 2:256"]);

    // Stating those defaults explicitly is the same behaviour: an absent binding and the
    // default value are one answer, so an unconfigured box answers identically with the
    // knobs read.
    const explicit = await runWith({
      NEIGHBOUR_EXPANSION_RADIUS: String(DEFAULT_NEIGHBOUR_RADIUS),
      NEIGHBOUR_EXPANSION_CAP: String(DEFAULT_NEIGHBOUR_CAP),
    });
    expect(explicit.neighbourReads).toEqual(unset.neighbourReads);
    expect(explicit.detail).toEqual(unset.detail);
    expect(explicit.context).toBe(unset.context);
  });

  it("honours the documented disable: a zero radius issues no read at all", async () => {
    const run = await runWith({ NEIGHBOUR_EXPANSION_RADIUS: "0" });

    // `0` is a configured value, not an absent one: it must reach the retriever as zero
    // and turn the expansion off, so the context holds the fused hit alone.
    expect(run.neighbourReads).toEqual([]);
    expect(run.detail).toBeUndefined();
    expect(neighbourCitationsIn(run.context)).toEqual([]);
  });
});

type TunableProbe = {
  /** The environment binding the composition root parses this knob from; `null` when
   * serving binds none and states the retriever's own default instead. */
  binding: { name: string; value: string } | null;
  /** The question that drives the arm this knob feeds. */
  question: string;
  /** Asserts the knob's value reached the read or the event it bounds. */
  assert: (run: Run) => void;
};

/**
 * Every retriever tunable the serving deps carry, each driven to a distinctive value and
 * asserted where it acts. Keyed by the deps type: a knob the retriever gains, or a field
 * the `retrieval` deps gain, does not compile until this table states where it is bound
 * (or why it is not) and proves the value reaches its arm.
 */
const TUNABLES: Record<keyof Required<ChatPipelineDeps["retrieval"]>, TunableProbe> = {
  limit: {
    // Serving binds no variable to `limit`: it states `undefined`, the retriever's own
    // default, so the probe pins that stated absence to the depth of the search it bounds.
    binding: null,
    question: PLAIN_QUESTION,
    assert: (run) => {
      expect(run.searches.length).toBeGreaterThan(0);
      expect(new Set(run.searches.map((search) => search.limit))).toEqual(new Set([10]));
    },
  },
  scopeExpansionCap: {
    binding: { name: "SCOPE_EXPANSION_CAP", value: "4" },
    question: CITED_QUESTION,
    assert: (run) => {
      // The scope read asks for the cap plus one proof row.
      expect(run.scopeReads.map((read) => read.limit)).toEqual([5]);
      expect(run.scopeCaps).toEqual([4]);
    },
  },
  neighbourRadius: {
    binding: { name: "NEIGHBOUR_EXPANSION_RADIUS", value: "2" },
    question: PLAIN_QUESTION,
    assert: (run) => {
      expect(run.neighbourReads.map((read) => read.radius)).toEqual([2]);
      expect(run.detail).toMatchObject({ radius: 2 });
    },
  },
  neighbourCap: {
    binding: { name: "NEIGHBOUR_EXPANSION_CAP", value: "5" },
    question: PLAIN_QUESTION,
    assert: (run) => {
      // The read asks for the cap, plus one slot per row already in context (the verse
      // anchor and the chained hadith), plus one proof row.
      expect(run.neighbourReads.map((read) => read.limit)).toEqual([5 + 2 + 1]);
      expect(run.detail).toMatchObject({ cap: 5 });
    },
  },
  labelLookupCap: {
    binding: { name: "LABEL_LOOKUP_CAP", value: "3" },
    question: CITED_QUESTION,
    assert: (run) => {
      // The label read asks for the cap plus one proof row.
      expect(run.citationReads.map((read) => read.limit)).toEqual([4]);
      expect(run.citationCap).toBe(3);
    },
  },
  chainEvidenceChildCap: {
    // `0` is the discriminating value with the one chain-bearing child this fixture
    // seeds: the read is disabled, so the event records zero reads and names the
    // child unread. A dropped `childCap` forwarding falls back to the default,
    // issues the read, and reddens both assertions.
    binding: { name: "CHAIN_EVIDENCE_CHILD_CAP", value: "0" },
    question: PLAIN_QUESTION,
    assert: (run) => {
      expect(run.chainReads).toEqual([]);
      expect(run.chainEvidence).toMatchObject({ consulted: 0, notConsulted: expect.any(Array) });
      expect(run.chainEvidence?.notConsulted).toHaveLength(1);
    },
  },
  chainEvidenceChainCap: {
    // `1` is the discriminating value: the read asks for two rows (one plus the
    // proof row) and the event records the bound the run applied.
    binding: { name: "CHAIN_EVIDENCE_CHAIN_CAP", value: "1" },
    question: PLAIN_QUESTION,
    assert: (run) => {
      expect(run.chainReads.map((read) => read.limit)).toEqual([2]);
      expect(run.chainEvidence?.perChildCap).toBe(1);
    },
  },
  callerPriorityK: {
    // `0` is the discriminating value: it reaches the selection, so the typed event
    // records the bound the run applied and nothing is promoted. A knob the composition
    // root never forwarded would record the contract's default instead.
    binding: { name: "CALLER_PRIORITY_K", value: "0" },
    question: PLAIN_QUESTION,
    assert: (run) => {
      expect(run.callerPriority).toEqual({ k: 0, ids: [] });
    },
  },
};

describe("buildChatWiring — every configured retriever tunable reaches its arm", () => {
  it.each(Object.entries(TUNABLES))("forwards %s", async (knob, tunable) => {
    const run = await runWith(
      tunable.binding === null ? {} : { [tunable.binding.name]: tunable.binding.value },
      tunable.question,
    );
    tunable.assert(run);
  });

  it("refuses a zero per-chain row budget instead of carrying no row", () => {
    // The child budget's `0` is the read's disable, probed above as a run. The row
    // budget has no disable meaning: a zero would consult a child, carry no row and
    // lose the unread record, so the composition root refuses it before any read.
    expect(() => buildChatWiring({ ...KEYED_ENV, CHAIN_EVIDENCE_CHAIN_CAP: "0" })).toThrow(
      ChatConfigError,
    );
  });
});
