import { describe, expect, it, vi } from "vitest";
import type { RagStore } from "@app/infra";
import type { Provider } from "@app/rag-core";
import { runIngestion } from "./pipeline";
import type { ParsedParent } from "./types";

/** In-memory RagStore fake: idempotent by sourceKey / (parentId, ordinal). */
function fakeStore() {
  const parents = new Map<string, { id: string; title: string | null; metadata: unknown }>();
  const children = new Map<string, Record<string, unknown>>();
  const pairs = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const store: RagStore = {
    async insertDocParent(input) {
      seq += 1;
      const existing = parents.get(input.sourceKey);
      const id = existing?.id ?? `p${seq}`;
      parents.set(input.sourceKey, {
        id,
        title: input.title,
        metadata: input.metadata,
      });
      return id;
    },
    async insertDocChild(input) {
      seq += 1;
      const key = `${input.parentId}:${input.ordinal}`;
      const id = (children.get(key)?.id as string | undefined) ?? `c${seq}`;
      children.set(key, {
        id,
        textRaw: input.textRaw,
        textAr: input.textAr,
        textId: input.textId ?? null,
        ordinal: input.ordinal,
      });
      return id;
    },
    async insertDocChildren(batch) {
      return Promise.all(batch.map((input) => this.insertDocChild(input)));
    },
    async upsertAlignedPair(input) {
      const existing = pairs.get(input.pairKey);
      const id = typeof existing?.id === "string" ? existing.id : `pair${pairs.size + 1}`;
      pairs.set(input.pairKey, { id, ...input });
      return id;
    },
    async similaritySearch() {
      return [];
    },
    async insertAnswerTrace() {
      return "";
    },
    async getAnswerTraceByMessage() {
      return null;
    },
    async createChatSession() {
      return "";
    },
    async insertChatMessage() {
      return "";
    },
    async createSession() {
      return { userId: "", sessionId: "", token: "", expiresAt: 0 };
    },
    async resolveUserId() {
      return null;
    },
    async deleteUserCascade() {},
    async cleanupExpiredSessions() {
      return 0;
    },
    async insertEvalRun(input) {
      return input.id ?? `eval${(seq += 1)}`;
    },
  };
  return {
    store,
    parents: () => [...parents.values()],
    children: () => [...children.values()],
    pairs: () => [...pairs.values()],
  };
}

/** Deterministic embedder: vector is the text hash repeated to a fixed dim. */
function fakeProvider(dim = 8): Provider {
  return {
    modelId: "fake-embedder",
    async embed(spec) {
      const vectors = spec.texts.map((text) => {
        const seed = [...text].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 997, 7);
        return Array.from({ length: dim }, (_, i) => ((seed + i) % 17) / 17);
      });
      return {
        vectors,
        cost: {
          modelId: "fake-embedder",
          tokensIn: spec.texts.length,
          tokensOut: 0,
          latencyMs: 1,
          costMicroUsd: spec.texts.length,
        },
      };
    },
    async generate() {
      throw new Error("not used");
    },
    async stream() {
      throw new Error("not used");
    },
  };
}

function twoParents(): ParsedParent[] {
  return [
    {
      sourceKey: "src/1",
      title: "One",
      metadata: { k: 1 },
      children: [
        {
          sourceKey: "src/1:0",
          textRaw: "raw one",
          textPrimary: "primary one",
          textSecondary: "secondary one",
          citation: { c: 1 },
          metadata: {},
        },
        {
          sourceKey: "src/1:1",
          textRaw: "raw two",
          textPrimary: "primary two",
          textSecondary: "secondary two",
          citation: { c: 2 },
          metadata: {},
        },
      ],
    },
    {
      sourceKey: "src/2",
      title: "Two",
      metadata: {},
      children: [
        {
          sourceKey: "src/2:0",
          textRaw: "raw three",
          textPrimary: "primary three",
          textSecondary: null,
          citation: { c: 3 },
          metadata: {},
        },
      ],
    },
  ];
}

describe("runIngestion", () => {
  it("writes parents and children, embedding both tracks and recording costs", async () => {
    const f = fakeStore();
    const provider = fakeProvider();
    const result = await runIngestion(
      async () => twoParents(),
      { archiveKey: "archive/key", raw: new Uint8Array() },
      { store: f.store, embedder: provider, summarizer: null },
    );

    expect(result.parentIds).toHaveLength(2);
    expect(f.children()).toHaveLength(3);
    // Primary track embedded for all 3 children; secondary for all 3 rows
    // (the null-secondary row embeds ""), so cost = 3 + 3 = 6 micro-USD.
    expect(result.report.llmCalls).toHaveLength(2);
    expect(result.report.childrenWritten).toBe(3);
    expect(result.report.parentsWritten).toBe(2);
    expect(result.report.costMicroUsd).toBe(6);
    expect(result.report.details?.embeddedSecondaryTrack).toBe(true);
  });

  it("is idempotent: re-running produces no duplicate parents or children", async () => {
    const f = fakeStore();
    const run = () =>
      runIngestion(
        async () => twoParents(),
        { archiveKey: "archive/key", raw: new Uint8Array() },
        { store: f.store, embedder: fakeProvider(), summarizer: null },
      );
    await run();
    await run();
    expect(f.parents()).toHaveLength(2);
    expect(f.children()).toHaveLength(3);
  });

  it("stores the LLM parent summary and embeds parents from summaries", async () => {
    const f = fakeStore();
    const summarizer = vi.fn(async (input: { sourceKey: string }) => `summary ${input.sourceKey}`);
    await runIngestion(
      async () => twoParents(),
      { archiveKey: "archive/key", raw: new Uint8Array() },
      { store: f.store, embedder: fakeProvider(), summarizer },
    );
    expect(summarizer).toHaveBeenCalledTimes(2);
    const p1 = f.parents().find((p) => p.title === "One");
    expect((p1?.metadata as Record<string, unknown>)?.summary).toBe("summary src/1");
  });

  it("rejects a parser that emits duplicate parent keys (fail loudly, never dupe)", async () => {
    const f = fakeStore();
    const dup = twoParents();
    dup.push({ ...dup[0]! });
    await expect(
      runIngestion(
        async () => dup,
        { archiveKey: "k", raw: new Uint8Array() },
        { store: f.store, embedder: fakeProvider(), summarizer: null },
      ),
    ).rejects.toThrow(/duplicate parent sourceKey/);
  });

  it("rejects a child with empty primary text (canonical evidence is mandatory)", async () => {
    const f = fakeStore();
    const bad = twoParents();
    bad[0]!.children = [
      { ...bad[0]!.children[0]!, textPrimary: "  " },
      ...bad[0]!.children.slice(1),
    ];
    await expect(
      runIngestion(
        async () => bad,
        { archiveKey: "k", raw: new Uint8Array() },
        { store: f.store, embedder: fakeProvider(), summarizer: null },
      ),
    ).rejects.toThrow(/empty primary text/);
  });

  it("rejects a summarizer that returns an empty summary", async () => {
    const f = fakeStore();
    await expect(
      runIngestion(
        async () => twoParents(),
        { archiveKey: "k", raw: new Uint8Array() },
        { store: f.store, embedder: fakeProvider(), summarizer: async () => "" },
      ),
    ).rejects.toThrow(/empty summary/);
  });
});