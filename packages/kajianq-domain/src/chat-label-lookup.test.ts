import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { RunContext, type Answer, type Chunk, type RoutedQuery } from "@app/rag-core";
import { createKajianQRetriever } from "./chat-retriever";
import { runChatPipelinePromise, type ChatPipelineDeps } from "./chat-pipeline";
import type { GeneratorProvider } from "./chat-generator";
import { CITATION_LOOKUP_ORIGIN, DEFAULT_LABEL_LOOKUP_CAP } from "./chat-label-lookup";
import { DEFAULT_REFUSALS } from "./chat-refusal";
import type { KajianQFilters } from "./filters";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";
import { createStubChatProviders } from "./test-utils/stub-chat-providers";

/**
 * Citation-label lookup (ADR-0058) — the retrieval arm.
 *
 * The invariant under test: a question that names a stored citation label
 * retrieves the chunk carrying that label **even when dense retrieval ranks its
 * neighbours first**; a label the corpus does not carry adds no chunk (the run
 * still refuses, never answers from the string); and a question with no label is
 * untouched — same fused chunks, no store read, no trace event.
 */

const COST = { modelId: "stub-embedder", tokensIn: 1, tokensOut: 1, latencyMs: 1, costMicroUsd: 0 };
const QUERY_VEC = [1, 0, 0];
/** Close enough to rank in the fused top-k. */
const NEAR = [1, 0, 0];
/** Orthogonal to the query, so dense retrieval ranks the label's neighbours first. */
const FAR = [0, 1, 0];

const QUESTION_4697 = "Apa isi hadits pada HR. Bukhari no. 4697?";
const QUESTION_WUDHU = "Apa isi hadits tentang wudhu?";

type MemoryStore = ReturnType<typeof createMemoryRagStore>;

const DISPLAY: Record<string, string> = { bukhari: "Bukhari", malik: "Malik" };

async function seedHadith(
  store: MemoryStore,
  opts: {
    collection: string;
    book: number;
    hadithNo: string;
    ordinal: number;
    vector: readonly number[];
  },
): Promise<string> {
  const sourceKey = `hadith/${opts.collection}/section/${opts.book}`;
  const parentId = await Effect.runPromise(
    store.insertDocParent({
      sourceKey,
      title: `HR. ${DISPLAY[opts.collection] ?? opts.collection} — book ${opts.book}`,
      metadata: { sourceType: "hadith", collection: opts.collection, book: opts.book },
    }),
  );
  return Effect.runPromise(
    store.insertDocChild({
      parentId,
      textRaw: `arabic ${opts.hadithNo}`,
      textAr: `arabic ${opts.hadithNo}`,
      textId: `indonesian ${opts.hadithNo}`,
      citation: { sourceType: "hadith", collection: opts.collection, hadithNo: opts.hadithNo },
      embeddingPrimary: opts.vector,
      embeddingFallback: opts.vector,
      ordinal: opts.ordinal,
      metadata: {
        sourceType: "hadith",
        collection: opts.collection,
        hadithNo: opts.hadithNo,
        book: opts.book,
        citation: `HR. ${DISPLAY[opts.collection] ?? opts.collection} no. ${opts.hadithNo}`,
      },
    }),
  );
}

/**
 * The #277 corpus shape: Bukhari 4697 sits between two near neighbours that
 * dense retrieval reaches and it does not, exactly the reported failure.
 */
async function bukhariBook(): Promise<{ store: MemoryStore; ids: Record<string, string> }> {
  const store = createMemoryRagStore();
  const ids: Record<string, string> = {};
  ids["4696"] = await seedHadith(store, {
    collection: "bukhari",
    book: 65,
    hadithNo: "4696",
    ordinal: 0,
    vector: NEAR,
  });
  ids["4697"] = await seedHadith(store, {
    collection: "bukhari",
    book: 65,
    hadithNo: "4697",
    ordinal: 1,
    vector: FAR,
  });
  ids["4698"] = await seedHadith(store, {
    collection: "bukhari",
    book: 65,
    hadithNo: "4698",
    ordinal: 2,
    vector: NEAR,
  });
  return { store, ids };
}

type Recorded = { kind: string; detail?: unknown };

function harness(
  store: MemoryStore,
  opts: { cap?: number; limit?: number } = {},
): {
  retrieve: (routed: RoutedQuery<KajianQFilters>) => Promise<readonly Chunk[]>;
  events: Recorded[];
  reads: number[];
} {
  const events: Recorded[] = [];
  const reads: number[] = [];
  const spy = {
    ...store,
    findDocChildrenByMetadata(
      match: Readonly<Record<string, string | number>>,
      readOpts: { limit: number },
    ) {
      reads.push(readOpts.limit);
      return store.findDocChildrenByMetadata(match, readOpts);
    },
  };
  const retriever = createKajianQRetriever({
    store: spy,
    embedder: {
      embed: (spec) => Effect.succeed({ vectors: spec.texts.map(() => QUERY_VEC), cost: COST }),
    },
    bridge: (effect) => Effect.runPromise(effect),
    limit: opts.limit ?? 2,
    ...(opts.cap !== undefined ? { labelLookupCap: opts.cap } : {}),
  });
  const retrieve = (routed: RoutedQuery<KajianQFilters>) =>
    Effect.runPromise(
      Effect.provideService(retriever.retrieve(routed) as never, RunContext, {
        config: {},
        now: () => 1,
        record: (event: unknown) => events.push(event as Recorded),
      } as never) as never,
    ) as Promise<readonly Chunk[]>;
  return { retrieve, events, reads };
}

function routed(sourceText: string, subQueries: string[]): RoutedQuery<KajianQFilters> {
  return {
    intent: "factual",
    subQueries: subQueries.map((text) => ({ text })),
    filters: {},
    sourceText,
  };
}

function lookupEvent(events: readonly Recorded[]): Recorded | undefined {
  return events.find((event) => event.kind === "citation_lookup");
}

describe("citation-label lookup — retrieval seam", () => {
  it("retrieves the chunk the question's label addresses, beside the fused hits (#277)", async () => {
    const { store, ids } = await bukhariBook();
    const { retrieve, events, reads } = harness(store);
    const chunks = await retrieve(routed(QUESTION_4697, ["isi hadits bukhari 4697"]));

    // The neighbours are still there: the arm adds, never replaces.
    expect(chunks.some((chunk) => chunk.id === ids["4696"])).toBe(true);
    const labelled = chunks.filter((chunk) => chunk.origin === CITATION_LOOKUP_ORIGIN);
    expect(labelled.map((chunk) => chunk.id)).toEqual([ids["4697"]]);
    expect(labelled[0]?.text).toBe("arabic 4697");
    // The label chunk carries both text layers, like every deterministic read.
    expect(labelled[0]?.metadata?.["textAr"]).toBe("arabic 4697");
    expect(labelled[0]?.metadata?.["textId"]).toBe("indonesian 4697");

    expect(lookupEvent(events)?.detail).toEqual({
      labels: ["HR. Bukhari no. 4697"],
      missing: [],
      returned: 1,
      cap: DEFAULT_LABEL_LOOKUP_CAP,
      truncated: false,
    });
    // One bounded read, probing one past the budget for the truncation signal.
    expect(reads).toEqual([DEFAULT_LABEL_LOOKUP_CAP + 1]);
  });

  it("adds no chunk for a label the corpus does not carry, and records the miss", async () => {
    const { store } = await bukhariBook();
    const { retrieve, events } = harness(store);
    const chunks = await retrieve(
      routed("Apa isi hadits pada HR. Bukhari no. 999999?", ["isi hadits bukhari 999999"]),
    );

    expect(chunks.every((chunk) => chunk.origin !== CITATION_LOOKUP_ORIGIN)).toBe(true);
    expect(lookupEvent(events)?.detail).toEqual({
      labels: ["HR. Bukhari no. 999999"],
      missing: ["HR. Bukhari no. 999999"],
      returned: 0,
      cap: DEFAULT_LABEL_LOOKUP_CAP,
      truncated: false,
    });
  });

  it("does nothing for a question that names no label — no read, no event", async () => {
    const store = createMemoryRagStore();
    await seedHadith(store, {
      collection: "malik",
      book: 1,
      hadithNo: "1",
      ordinal: 0,
      vector: NEAR,
    });
    const { retrieve, events, reads } = harness(store);
    const chunks = await retrieve(routed(QUESTION_WUDHU, ["isi hadits wudhu"]));

    expect(chunks).toHaveLength(1);
    expect(chunks.every((chunk) => chunk.origin === undefined)).toBe(true);
    expect(lookupEvent(events)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("does not duplicate a chunk the fused tracks already retrieved", async () => {
    const store = createMemoryRagStore();
    const id = await seedHadith(store, {
      collection: "bukhari",
      book: 65,
      hadithNo: "4697",
      ordinal: 0,
      vector: NEAR,
    });
    const { retrieve, events } = harness(store);
    const chunks = await retrieve(routed(QUESTION_4697, ["isi hadits bukhari 4697"]));

    expect(chunks.filter((chunk) => chunk.id === id)).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.origin === CITATION_LOOKUP_ORIGIN)).toHaveLength(0);
    expect((lookupEvent(events)?.detail as { returned: number }).returned).toBe(0);
  });

  it("disables the arm at cap 0 without reading the store", async () => {
    const { store } = await bukhariBook();
    const { retrieve, events, reads } = harness(store, { cap: 0 });
    const chunks = await retrieve(routed(QUESTION_4697, ["isi hadits bukhari 4697"]));

    expect(chunks.every((chunk) => chunk.origin !== CITATION_LOOKUP_ORIGIN)).toBe(true);
    expect(lookupEvent(events)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("caps what one label may add and reports the truncation", async () => {
    const store = createMemoryRagStore();
    for (let book = 1; book <= 3; book += 1) {
      await seedHadith(store, {
        collection: "bukhari",
        book,
        hadithNo: "1",
        ordinal: 0,
        vector: FAR,
      });
    }
    // Two near neighbours fill the fused top-k, so none of the labelled rows is
    // already in context and the label's own budget is what truncates.
    for (let book = 1; book <= 2; book += 1) {
      await seedHadith(store, {
        collection: "malik",
        book,
        hadithNo: String(book),
        ordinal: 0,
        vector: NEAR,
      });
    }
    const { retrieve, events } = harness(store, { cap: 2 });
    const chunks = await retrieve(routed("Jelaskan HR. Bukhari no. 1.", ["hadits bukhari 1"]));

    expect(chunks.filter((chunk) => chunk.origin === CITATION_LOOKUP_ORIGIN)).toHaveLength(2);
    expect(lookupEvent(events)?.detail).toEqual({
      labels: ["HR. Bukhari no. 1"],
      missing: [],
      returned: 2,
      cap: 2,
      truncated: true,
    });
  });
});

type CapturedGenerator = { turns: readonly { role: string; content: string }[] };

function pipelineDeps(
  store: MemoryStore,
  overrides: Parameters<typeof createStubChatProviders>[0] = {},
  captured: CapturedGenerator[] = [],
): ChatPipelineDeps {
  const providers = createStubChatProviders(overrides);
  const generator: GeneratorProvider = providers.generatorProvider;
  // The pipeline prefers `stream`, so both entry points record the spec they
  // were handed: the assertion is about the evidence, not about which method served it.
  const stream = generator.stream;
  const capturedProvider: GeneratorProvider = {
    generate: (spec) => {
      captured.push(spec);
      return generator.generate(spec);
    },
    ...(stream !== undefined
      ? {
          stream: (spec) => {
            captured.push(spec);
            return stream(spec);
          },
        }
      : {}),
  };
  return {
    ...providers,
    store,
    bridge: (effect) => Effect.runPromise(effect),
    language: "id",
    retrieverLimit: 2,
    generatorProvider: capturedProvider,
  };
}

describe("citation-label lookup — delivered answer", () => {
  it("grounds and delivers a citation of the label the question named (#277)", async () => {
    const { store, ids } = await bukhariBook();
    const captured: CapturedGenerator[] = [];
    const answer = await runChatPipelinePromise(
      pipelineDeps(
        store,
        { answerText: "Hadits HR. Bukhari no. 4697 menerangkan isinya." },
        captured,
      ),
      { text: QUESTION_4697 },
    );

    expect(answer.text).toContain("HR. Bukhari no. 4697");
    const trace = answer.trace;
    const retrieval = trace.events.find((event) => event.kind === "retrieval");
    const refs = retrieval?.kind === "retrieval" ? retrieval.detail.chunks : [];
    expect(
      refs.some((ref) => ref.id === ids["4697"] && ref.origin === CITATION_LOOKUP_ORIGIN),
    ).toBe(true);
    const review = trace.events.find((event) => event.kind === "review");
    expect(review?.kind === "review" ? review.detail.grounded : undefined).toContain(
      "HR. Bukhari no. 4697",
    );
    expect(trace.events.some((event) => event.kind === "refusal")).toBe(false);
    // The generator was given the retrieved passage, not asked to answer from the label.
    const context =
      captured
        .at(0)
        ?.turns.map((turn) => turn.content)
        .join("\n") ?? "";
    expect(context).toContain("arabic 4697");
  });

  it("refuses when the named label is not in the corpus, never answering from the string", async () => {
    const { store } = await bukhariBook();
    const captured: CapturedGenerator[] = [];
    const answer = await runChatPipelinePromise(
      pipelineDeps(store, { answerText: DEFAULT_REFUSALS.id }, captured),
      { text: "Apa isi hadits pada HR. Bukhari no. 999999?" },
    );

    expect(answer.text).toBe(DEFAULT_REFUSALS.id);
    const trace = answer.trace;
    const retrieval = trace.events.find((event) => event.kind === "retrieval");
    const refs = retrieval?.kind === "retrieval" ? retrieval.detail.chunks : [];
    expect(refs.some((ref) => ref.origin === CITATION_LOOKUP_ORIGIN)).toBe(false);
    const lookup = trace.events.find((event) => event.kind === "citation_lookup");
    expect(lookup?.kind === "citation_lookup" ? lookup.detail.missing : undefined).toEqual([
      "HR. Bukhari no. 999999",
    ]);
    const refusal = trace.events.find((event) => event.kind === "refusal");
    expect(refusal?.kind === "refusal" ? refusal.detail?.trigger : undefined).toBe(
      "generator_refusal",
    );
    // The assembled evidence carries no passage for the phantom label.
    const context =
      captured
        .at(0)
        ?.turns.map((turn) => turn.content)
        .join("\n") ?? "";
    expect(context).not.toContain("arabic 999999");
  });

  it("leaves a neighbouring question with no label exactly as it was", async () => {
    const store = createMemoryRagStore();
    const id = await seedHadith(store, {
      collection: "malik",
      book: 1,
      hadithNo: "1",
      ordinal: 0,
      vector: NEAR,
    });
    const run = (labelLookupCap?: number) =>
      runChatPipelinePromise(
        {
          ...pipelineDeps(store, { answerText: "Hadits tentang wudhu." }),
          ...(labelLookupCap !== undefined ? { labelLookupCap } : {}),
        },
        { text: QUESTION_WUDHU },
      );

    const before = await run(0);
    const after = await run();
    const idsOf = (answer: Answer) => {
      const event = answer.trace.events.find((candidate) => candidate.kind === "retrieval");
      return event?.kind === "retrieval" ? event.detail.chunks.map((ref) => ref.id) : [];
    };
    expect(idsOf(after)).toEqual(idsOf(before));
    expect(idsOf(after)).toEqual([id]);
    expect(after.trace.events.filter((event) => event.kind === "citation_lookup")).toHaveLength(0);
    expect(after.text).toBe(before.text);
  });

  it("honours the pipeline's configured lookup cap (0 disables the arm through the wiring)", async () => {
    const { store, ids } = await bukhariBook();
    const answer = await runChatPipelinePromise(
      { ...pipelineDeps(store, { answerText: "Jawaban." }), labelLookupCap: 0 },
      { text: QUESTION_4697 },
    );

    const event = answer.trace.events.find((candidate) => candidate.kind === "retrieval");
    const refs = event?.kind === "retrieval" ? event.detail.chunks : [];
    expect(refs.some((ref) => ref.id === ids["4697"])).toBe(false);
    expect(
      answer.trace.events.filter((candidate) => candidate.kind === "citation_lookup"),
    ).toHaveLength(0);
  });
});
