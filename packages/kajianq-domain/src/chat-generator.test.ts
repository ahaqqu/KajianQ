import { Effect, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { ProviderError, RunContext, type AssembledContext, type Chunk } from "@app/rag-core";
import type { CostRecord } from "@app/contracts";
import { createKajianQGenerator, REFUSAL_REREAD_LIMIT } from "./chat-generator";
import { ADDRESSED_EVIDENCE_PROMPT } from "./chat-prompts";
import { DEFAULT_REFUSALS, createKajianQReviewer } from "./chat-reviewer";
import type { KajianQFilters } from "./filters";
import { runChatPipeline } from "./chat-pipeline";
import { createStubChatProviders } from "./test-utils/stub-chat-providers";
import { createMemoryRagStore } from "./test-utils/memory-rag-store";
import { routedQuery } from "./test-utils/routed-query";

/**
 * Generator + reviewer behavior: the generator settles the streamed call's cost into the
 * trace, and the reviewer's deterministic citation gate refuses ungrounded answers
 * regardless of the LLM reviewer. The last block runs the real five-stage pipeline.
 */

const cost = (modelId: string, microUsd: number): CostRecord => ({
  modelId,
  tokensIn: 3,
  tokensOut: 5,
  latencyMs: 7,
  costMicroUsd: microUsd,
});

const context = (
  chunks: readonly Chunk[],
  question = "Apa itu Ayat Kursi?",
): AssembledContext<KajianQFilters> => ({
  query: routedQuery(question),
  chunks,
  turns: [{ role: "user", content: chunks.map((c) => c.text).join("\n") }],
});

const chunk = (label: string): Chunk => ({
  id: `c-${label}`,
  text: "evidence",
  metadata: { citation: label },
});

/** Run one stage effect with a minimal `RunContext`; the trace sink is a no-op here —
 * tests that assert on recorded events provide their own context. */
function runStage<A>(effect: unknown): Promise<A> {
  return Effect.runPromise(
    Effect.provideService(effect as never, RunContext, {
      config: {},
      now: () => 1,
      record: () => {},
    } as never) as never,
  ) as Promise<A>;
}

describe("createKajianQGenerator — streaming", () => {
  it("collects the vendor's deltas into the draft and forwards each one", async () => {
    const seen: string[] = [];
    const gen = createKajianQGenerator({
      provider: {
        generate: () => Effect.die("generate must not be used when stream exists"),
        stream: () =>
          Effect.succeed({
            deltas: Stream.fromIterable(["Menurut ", "QS. 2:255", " …"]),
            cost: () => Effect.succeed(cost("stub", 5)),
          }),
      },
      language: "id",
      onDelta: (d) => seen.push(d),
    });
    const draft = await runStage<{ text: string }>(gen.generate(context([chunk("QS. 2:255")])));
    expect(draft.text).toBe("Menurut QS. 2:255 …");
    expect(seen).toEqual(["Menurut ", "QS. 2:255", " …"]);
  });

  it("calls the provider's stream with its receiver attached", async () => {
    // The real provider implements `stream` as a method that reads `this`, so the stub must
    // be bound exactly like it: an object-literal stub with arrow functions cannot catch a
    // detached receiver.
    const provider = {
      modelId: "bound-provider",
      generate: () => Effect.die("generate must not be used when stream exists"),
      stream: function (this: { modelId: string }) {
        return Effect.succeed({
          deltas: Stream.fromIterable([`ok:${this.modelId}`]),
          cost: () => Effect.succeed(cost("bound-provider", 1)),
        });
      },
    };
    const gen = createKajianQGenerator({ provider: provider as never, language: "id" });
    const draft = await runStage<{ text: string }>(gen.generate(context([chunk("QS. 2:255")])));
    expect(draft.text).toBe("ok:bound-provider");
  });

  it("sends the verbatim question — never the router's intent — in the user turn", async () => {
    // The prompt reads `sourceText`, the text the engine stamped — never the router's intent.
    let turns: readonly { role: string; content: string }[] = [];
    const gen = createKajianQGenerator({
      provider: {
        generate: () => Effect.die("generate must not be used when stream exists"),
        stream: (spec) => {
          turns = spec.turns;
          return Effect.succeed({
            deltas: Stream.fromIterable(["ok"]),
            cost: () => Effect.succeed(cost("stub", 1)),
          });
        },
      },
      language: "id",
    });
    await runStage(gen.generate(context([chunk("QS. 2:255")])));
    const user = turns.at(-1)?.content ?? "";
    expect(user).toContain("Pertanyaan / Question: Apa itu Ayat Kursi?");
    expect(user).not.toContain("Question: factual");
  });

  it("falls back to a single generate call when the provider cannot stream", async () => {
    const gen = createKajianQGenerator({
      provider: {
        generate: () => Effect.succeed({ text: "buffered answer", cost: cost("stub", 5) }),
      },
      language: "id",
    });
    const draft = await runStage<{ text: string }>(gen.generate(context([])));
    expect(draft.text).toBe("buffered answer");
  });

  it("records the streamed call's cost to the run's trace sink", async () => {
    // The cost must land on the trace even though it settles only after the stream ends.
    const events: { kind: string; cost?: CostRecord }[] = [];
    const gen = createKajianQGenerator({
      provider: {
        generate: () => Effect.die("unused"),
        stream: () =>
          Effect.succeed({
            deltas: Stream.fromIterable(["x"]),
            cost: () => Effect.succeed(cost("stub-model", 42)),
          }),
      },
      language: "id",
    });
    const { RunContext } = await import("@app/rag-core");
    await Effect.runPromise(
      Effect.provideService(gen.generate(context([])) as never, RunContext, {
        config: {},
        now: () => 1,
        record: (e: { kind: string; cost?: CostRecord }) => events.push(e),
      } as never) as never,
    );
    const llm = events.find((e) => e.kind === "llm_call");
    expect(llm?.cost?.modelId).toBe("stub-model");
    expect(llm?.cost?.costMicroUsd).toBe(42);
  });

  it("propagates a mid-flight stream failure as the stage's typed failure", async () => {
    const gen = createKajianQGenerator({
      provider: {
        generate: () => Effect.die("unused"),
        stream: () =>
          Effect.succeed({
            deltas: Stream.fail({ kind: "transport", message: "wire cut" } as never),
            cost: () => Effect.succeed(cost("stub", 1)),
          }),
      },
      language: "id",
    });
    await expect(runStage(gen.generate(context([])))).rejects.toBeTruthy();
  });
});

/**
 * A refusal is a reading of the evidence, not a verdict on the topic. A single
 * sampled refusal is not shipped: the generator rereads the same turns, and the
 * refusal ships only when the reread declines too. Both readings pay and both
 * costs land on the trace. Only a pure refusal is reread: a draft that answers,
 * a hybrid partial answer carrying the sentence included, is final.
 */
describe("createKajianQGenerator — the refusal reread", () => {
  const refusal = "tidak menemukan dalil yang memadai";
  /** A grounded partial answer that runs into the canonical sentence. */
  const hybrid =
    "Konteks menyebut QS. 2:255 dan tidak menjawab bagian lain. tidak menemukan dalil yang memadai";
  /** Content of the draft's own, no citation, plus the canonical sentence. */
  const asserting = "Hadits tentang keutamaan Tarawih sahih. tidak menemukan dalil yang memadai";

  type StageRun = {
    draft: { text: string };
    seen: string[][];
    events: { kind: string; detail?: { purpose?: string }; cost?: CostRecord }[];
  };

  /** Run the stage against a scripted provider, keyed by call index. */
  const runScripted = async (
    reply: (call: number) => Effect.Effect<{ text: string; cost: CostRecord }, unknown>,
  ): Promise<StageRun> => {
    const seen: string[][] = [];
    const events: StageRun["events"] = [];
    const gen = createKajianQGenerator({
      provider: {
        generate: (spec) => {
          seen.push(spec.turns.map((turn) => turn.content));
          return reply(seen.length - 1);
        },
      },
      language: "id",
    });
    const { RunContext } = await import("@app/rag-core");
    const draft = (await Effect.runPromise(
      Effect.provideService(gen.generate(context([chunk("QS. 2:255")])) as never, RunContext, {
        config: {},
        now: () => 1,
        record: (e: never) => events.push(e),
      } as never) as never,
    )) as { text: string };
    return { draft, seen, events };
  };

  const recording = (replies: readonly string[]): Promise<StageRun> =>
    runScripted((call) =>
      Effect.succeed({ text: replies[call] ?? replies.at(-1) ?? refusal, cost: cost("stub", 7) }),
    );

  /** The first reading declines; the reread fails with `failure`. */
  const rereadFails = (failure: unknown): Promise<StageRun> =>
    runScripted((call) =>
      call === 0 ? Effect.succeed({ text: refusal, cost: cost("stub", 7) }) : Effect.fail(failure),
    );

  it("rereads a refused draft on the same evidence and ships the answer", async () => {
    const { draft, seen, events } = await recording([refusal, "Menurut QS. 2:255 …"]);
    expect(draft.text).toBe("Menurut QS. 2:255 …");
    expect(seen).toHaveLength(2);
    // The reread sees the identical evidence: it is a second reading, not a new shot
    // at a different question.
    expect(seen[1]).toEqual(seen[0]);
    const calls = events.filter((e) => e.kind === "llm_call");
    expect(calls.map((e) => e.detail?.purpose)).toEqual(["generate", "generate_reread"]);
    // Every paid reading is on the trace, including the one that did not ship.
    expect(calls.map((e) => e.cost?.costMicroUsd)).toEqual([7, 7]);
  });

  it("ships the refusal when the reread declines too", async () => {
    const { draft, seen, events } = await recording([refusal, refusal]);
    expect(draft.text).toBe(refusal);
    expect(seen).toHaveLength(2);
    expect(events.filter((e) => e.kind === "llm_call")).toHaveLength(2);
  });

  it("does not reread an answer", async () => {
    const { draft, seen, events } = await recording(["Menurut QS. 2:255 …"]);
    expect(draft.text).toBe("Menurut QS. 2:255 …");
    expect(seen).toHaveLength(1);
    expect(events.filter((e) => e.kind === "llm_call")).toHaveLength(1);
  });

  it("does not reread a hybrid draft — a draft that answers is final", async () => {
    // The sentence detector is a substring match and also fires on a hybrid: the
    // canonical sentence riding a grounded partial answer. That draft has
    // answered, so a reread would spend a generation on an answer already
    // delivered and could replace it with a different one.
    const { draft, seen, events } = await recording([hybrid]);
    expect(draft.text).toBe(hybrid);
    expect(seen).toHaveLength(1);
    expect(events.filter((e) => e.kind === "llm_call")).toHaveLength(1);
  });

  it("does not reread an asserting refusal draft", async () => {
    // The other sentence-carrying shape: content of its own and no citation. The
    // product refuses it deterministically, so it is not a decline a second
    // reading could confirm or contradict.
    const { draft, seen } = await recording([asserting]);
    expect(draft.text).toBe(asserting);
    expect(seen).toHaveLength(1);
  });

  it("ships the reread's hybrid instead of the refusal it answered past", async () => {
    // Both call sites read the one predicate: a reread that answers part of the
    // question is not a second decline, so the refusal does not ship.
    const { draft, seen } = await recording([refusal, hybrid]);
    expect(draft.text).toBe(hybrid);
    expect(seen).toHaveLength(2);
  });

  it("pins the reread bound to one extra reading", async () => {
    // The stage, the spec and the decision record say one reread; a change to
    // the constant reddens here so the documents move with it.
    expect(REFUSAL_REREAD_LIMIT).toBe(1);
    const { seen } = await recording([refusal, refusal]);
    expect(seen).toHaveLength(1 + REFUSAL_REREAD_LIMIT);
  });

  it("does not reread a refusal on an empty context", async () => {
    const seen: string[][] = [];
    const gen = createKajianQGenerator({
      provider: {
        generate: (spec) => {
          seen.push(spec.turns.map((turn) => turn.content));
          return Effect.succeed({ text: refusal, cost: cost("stub", 7) });
        },
      },
      language: "id",
    });
    const draft = await runStage<{ text: string }>(gen.generate(context([])));
    expect(draft.text).toBe(refusal);
    expect(seen).toHaveLength(1);
  });

  it("keeps the first refusal when the reread fails", async () => {
    // The first reading earned the refusal and the second is optional: a
    // failure there must not turn an earned refusal into a stage failure, so
    // the refusal ships rather than the run rejecting.
    const { draft, seen, events } = await rereadFails({ kind: "transport", message: "wire cut" });
    expect(draft.text).toBe(refusal);
    expect(seen).toHaveLength(2);
    expect(events.filter((e) => e.kind === "llm_call")).toHaveLength(1);
  });

  it("records the failed reread's estimated spend on the trace", async () => {
    // A vendor-reaching attempt spent tokens even though it failed; the estimate
    // stays on the cost trail under the runner's label for a failed attempt.
    const { draft, events } = await rereadFails(
      new ProviderError({
        kind: "transport",
        message: "wire cut",
        attemptCosts: [cost("stub", 9)],
      }),
    );
    expect(draft.text).toBe(refusal);
    const calls = events.filter((e) => e.kind === "llm_call");
    expect(calls.map((e) => e.detail?.purpose)).toEqual(["generate", "failed-attempt"]);
    expect(calls.map((e) => e.cost?.costMicroUsd)).toEqual([7, 9]);
  });

  it("rereads via the streaming path too, keeping both readings' cost", async () => {
    const seen: number[] = [];
    const events: { kind: string; cost?: CostRecord }[] = [];
    const gen = createKajianQGenerator({
      provider: {
        generate: () => Effect.die("stream exists"),
        stream: () => {
          seen.push(seen.length + 1);
          const first = seen.length === 1;
          return Effect.succeed({
            deltas: Stream.fromIterable([first ? refusal : "Menurut QS. 2:255 …"]),
            cost: () => Effect.succeed(cost("stub", 3)),
          });
        },
      },
      language: "id",
    });
    const { RunContext } = await import("@app/rag-core");
    const draft = (await Effect.runPromise(
      Effect.provideService(gen.generate(context([chunk("QS. 2:255")])) as never, RunContext, {
        config: {},
        now: () => 1,
        record: (e: never) => events.push(e),
      } as never) as never,
    )) as { text: string };
    expect(draft.text).toBe("Menurut QS. 2:255 …");
    expect(seen).toHaveLength(2);
    expect(events.filter((e) => e.kind === "llm_call").map((e) => e.cost?.costMicroUsd)).toEqual([
      3, 3,
    ]);
  });

  it("keeps the first refusal when the reread's stream is cut mid-flight", async () => {
    // The production path: the reread's deltas are already forwarded to the
    // edge, so a cut stream must still ship the first refusal — and the failed
    // stream's estimated spend must still settle on the trace.
    const forwarded: string[] = [];
    const events: { kind: string; detail?: { purpose?: string }; cost?: CostRecord }[] = [];
    let calls = 0;
    const gen = createKajianQGenerator({
      provider: {
        generate: () => Effect.die("stream exists"),
        stream: () => {
          calls += 1;
          return Effect.succeed(
            calls === 1
              ? {
                  deltas: Stream.fromIterable([refusal]),
                  cost: () => Effect.succeed(cost("stub", 3)),
                }
              : {
                  deltas: Stream.concat(
                    Stream.fromIterable(["Sebagian jawaban "]),
                    Stream.fail(
                      new ProviderError({
                        kind: "transport",
                        message: "wire cut",
                        attemptCosts: [cost("stub", 4)],
                      }),
                    ),
                  ),
                  cost: () => Effect.succeed(cost("stub", 4)),
                },
          );
        },
      },
      language: "id",
      onDelta: (delta) => forwarded.push(delta),
    });
    const { RunContext } = await import("@app/rag-core");
    const draft = (await Effect.runPromise(
      Effect.provideService(gen.generate(context([chunk("QS. 2:255")])) as never, RunContext, {
        config: {},
        now: () => 1,
        record: (e: never) => events.push(e),
      } as never) as never,
    )) as { text: string };
    expect(draft.text).toBe(refusal);
    expect(forwarded).toEqual([refusal, "Sebagian jawaban "]);
    const calls2 = events.filter((e) => e.kind === "llm_call");
    expect(calls2.map((e) => e.detail?.purpose)).toEqual(["generate", "failed-attempt"]);
  });
});

/**
 * The addressed-evidence reread (ADR-0055): when the question names a citation
 * address the assembled context carries, the second reading is pointed at that
 * evidence instead of repeating the same reading. It is the deterministic
 * signal that separates an answerable named-verse question from the trap shape
 * (no named address) — the model still writes the answer, so these tests pin
 * the code's signal and what ships, never the model's wording.
 */
describe("createKajianQGenerator — the addressed-evidence reread", () => {
  const refusal = DEFAULT_REFUSALS.id;
  const question = "Jelaskan perbedaan niat dan ikhlas berdasarkan QS. 98:5!";
  const evidence = "QS. 98:5 — wa ma umiru illa liya'budu Allah …";

  /** A chunk whose stored identity is the address the question names. */
  const verse = (): Chunk => ({
    id: "c-qs-98-5",
    text: evidence,
    metadata: { citation: "QS. 98:5", sourceType: "quran", surah: 98, ayah: 5 },
  });
  /** A hadith the context carries but the question names no address for. */
  const unaddressed = (): Chunk => ({
    id: "c-hr-ibn-majah-224",
    text: "hadith text",
    metadata: {
      citation: "HR. Ibn Majah no. 224",
      sourceType: "hadith",
      collection: "ibnmajah",
      hadithNo: "224",
    },
  });

  type StageRun = {
    draft: { text: string };
    seen: string[][];
    events: {
      kind: string;
      detail?: { purpose?: string; addressed?: readonly string[] };
      cost?: CostRecord;
    }[];
  };

  const runScripted = async (
    ctx: AssembledContext<KajianQFilters>,
    replies: readonly string[],
  ): Promise<StageRun> => {
    const seen: string[][] = [];
    const events: StageRun["events"] = [];
    const gen = createKajianQGenerator({
      provider: {
        generate: (spec) => {
          seen.push(spec.turns.map((turn) => turn.content));
          return Effect.succeed({
            text: replies[seen.length - 1] ?? refusal,
            cost: cost("stub", 7),
          });
        },
      },
      language: "id",
    });
    const { RunContext } = await import("@app/rag-core");
    const draft = (await Effect.runPromise(
      Effect.provideService(gen.generate(ctx) as never, RunContext, {
        config: {},
        now: () => 1,
        record: (e: never) => events.push(e),
      } as never) as never,
    )) as { text: string };
    return { draft, seen, events };
  };

  it("points the reread at the evidence the question names and ships its answer", async () => {
    const { draft, seen, events } = await runScripted(context([verse(), unaddressed()], question), [
      refusal,
      "Menurut QS. 98:5, ikhlas adalah …",
    ]);
    expect(draft.text).toBe("Menurut QS. 98:5, ikhlas adalah …");
    expect(seen).toHaveLength(2);
    // The second reading is the same question and evidence, with the carried
    // passage named and the canonical refusal left available for what it does
    // not state — the reread may still decline.
    expect(seen[1]?.[1]).toContain(question);
    expect(seen[1]?.[1]).toContain(evidence);
    expect(seen[1]?.[1]).toContain(`"${DEFAULT_REFUSALS.id}" tetap berlaku`);
    // The first reading is the plain prompt: an answer never pays the directive.
    expect(seen[0]?.[1]).not.toContain("tetap berlaku");
    const calls = events.filter((e) => e.kind === "llm_call");
    expect(calls.map((e) => e.detail?.purpose)).toEqual(["generate", "generate_addressed_reread"]);
    // The trace names the addressed labels the reread was pointed at; the plain
    // first reading carries none.
    expect(calls.map((e) => e.detail?.addressed)).toEqual([undefined, ["QS. 98:5"]]);
    expect(calls.map((e) => e.cost?.costMicroUsd)).toEqual([7, 7]);
  });

  it("ships the first refusal when a directed reread declines with different wording", async () => {
    // The model is still the writer: a refusal that survives a reading pointed
    // at the named evidence is the recorded residual, never a licence to
    // fabricate an answer. The second reading uses the floor's polite decline,
    // so a path that promoted a declining reread would ship the wrong text.
    const politeDecline = "Mohon maaf. Kami tidak menemukan dalil yang memadai.";
    const { draft, events } = await runScripted(context([verse()], question), [
      refusal,
      politeDecline,
    ]);
    expect(draft.text).toBe(refusal);
    expect(events.filter((e) => e.kind === "llm_call").map((e) => e.detail?.purpose)).toEqual([
      "generate",
      "generate_addressed_reread",
    ]);
  });

  it("keeps the plain reread when the question names no address — the trap shape", async () => {
    const trapQuestion =
      "Sebutkan hadits yang memerintahkan mencari ilmu sampai ke negeri China dan jelaskan sanadnya!";
    const { draft, seen, events } = await runScripted(context([unaddressed()], trapQuestion), [
      refusal,
      refusal,
    ]);
    expect(draft.text).toBe(refusal);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[0]?.[1]).not.toContain("tetap berlaku");
    expect(events.filter((e) => e.kind === "llm_call").map((e) => e.detail?.purpose)).toEqual([
      "generate",
      "generate_reread",
    ]);
  });

  it("keeps the plain reread when the named address is absent from the context", async () => {
    // A label the corpus does not carry is not addressed evidence (ADR-0058):
    // the refused question stays on the ordinary reread.
    const { seen, events } = await runScripted(context([unaddressed()], "Apa makna QS. 98:5?"), [
      refusal,
      refusal,
    ]);
    expect(seen[1]).toEqual(seen[0]);
    expect(events.filter((e) => e.kind === "llm_call").map((e) => e.detail?.purpose)).toEqual([
      "generate",
      "generate_reread",
    ]);
  });

  it("stamps no directive on a first reading that answers", async () => {
    const { draft, seen, events } = await runScripted(context([verse()], question), [
      "Menurut QS. 98:5 …",
    ]);
    expect(draft.text).toBe("Menurut QS. 98:5 …");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[1]).not.toContain("tetap berlaku");
    expect(events.filter((e) => e.kind === "llm_call")).toHaveLength(1);
  });
});

describe("createKajianQReviewer — the deterministic gate", () => {
  const draft = (text: string): { text: string } => ({ text });

  it("passes a grounded answer through, adding only the ulama disclaimer", async () => {
    const reviewer = createKajianQReviewer({ provider: null, applyProductRules: false });
    const out = await runStage<{ text: string }>(
      reviewer.review(draft("Menurut QS. 2:255 …"), context([chunk("QS. 2:255")])),
    );
    expect(out.text).toBe("Menurut QS. 2:255 …");
  });

  it("adds the ulama disclaimer to a passed draft (product rule)", async () => {
    const reviewer = createKajianQReviewer({ provider: null });
    const out = await runStage<{ text: string }>(
      reviewer.review(draft("Menurut QS. 2:255 …"), context([chunk("QS. 2:255")])),
    );
    expect(out.text).toContain("Menurut QS. 2:255 …");
    expect(out.text).toContain("bukan fatwa");
  });

  it("refuses an ungrounded citation even with no LLM reviewer configured", async () => {
    const reviewer = createKajianQReviewer({ provider: null });
    const out = await runStage<{ text: string }>(
      reviewer.review(draft("QS. 9:99 menyebutkan …"), context([chunk("QS. 2:255")])),
    );
    expect(out.text).toBe("tidak menemukan dalil yang memadai");
    expect(out.text).not.toContain("QS. 9:99");
  });

  it("records the refusal with a machine-readable trigger", async () => {
    const events: { kind: string; detail?: { trigger?: string } }[] = [];
    const { RunContext } = await import("@app/rag-core");
    const reviewer = createKajianQReviewer({ provider: null });
    await Effect.runPromise(
      Effect.provideService(reviewer.review(draft("QS. 9:99"), context([])) as never, RunContext, {
        config: {},
        now: () => 1,
        record: (e: never) => events.push(e),
      } as never) as never,
    );
    const refusal = events.find((e) => e.kind === "refusal");
    expect(refusal?.detail?.trigger).toBe("ungrounded_citation");
  });

  it("refuses in English when the answer language is English", async () => {
    const reviewer = createKajianQReviewer({
      provider: null,
      refusalText: (reason) =>
        reason === "ungrounded" ? "could not find adequate evidence" : "not supported",
    });
    const out = await runStage<{ text: string }>(reviewer.review(draft("QS. 9:99"), context([])));
    expect(out.text).toBe("could not find adequate evidence");
  });

  it("gates on the LLM verdict when the reviewer fails the draft", async () => {
    const reviewer = createKajianQReviewer({
      provider: {
        generate: () =>
          Effect.succeed({
            text: JSON.stringify({ verdict: "fail", reason: "unsupported claim" }),
            cost: cost("reviewer", 3),
          }),
      },
    });
    const out = await runStage<{ text: string }>(
      reviewer.review(draft("Grounded text QS. 2:255"), context([chunk("QS. 2:255")])),
    );
    expect(out.text).not.toContain("QS. 2:255");
  });

  it("keeps a grounded answer when the LLM verdict passes", async () => {
    const reviewer = createKajianQReviewer({
      provider: {
        generate: () =>
          Effect.succeed({
            text: JSON.stringify({ verdict: "pass", reason: "ok" }),
            cost: cost("reviewer", 3),
          }),
      },
      applyProductRules: false,
    });
    const out = await runStage<{ text: string }>(
      reviewer.review(draft("Grounded text QS. 2:255"), context([chunk("QS. 2:255")])),
    );
    expect(out.text).toBe("Grounded text QS. 2:255");
  });

  it("refuses ungrounded BEFORE calling the reviewer LLM (never spends on a known-bad draft)", async () => {
    let called = 0;
    const reviewer = createKajianQReviewer({
      provider: {
        generate: () => {
          called += 1;
          return Effect.succeed({ text: '{"verdict":"pass"}', cost: cost("reviewer", 3) });
        },
      },
    });
    const out = await runStage<{ text: string }>(reviewer.review(draft("QS. 9:99"), context([])));
    expect(out.text).toBe("tidak menemukan dalil yang memadai");
    expect(called).toBe(0);
  });

  it("records grounded provenance on the review event (B4)", async () => {
    const events: { kind: string; detail?: { grounded?: string[] } }[] = [];
    const { RunContext } = await import("@app/rag-core");
    const reviewer = createKajianQReviewer({
      provider: {
        generate: () => Effect.succeed({ text: '{"verdict":"pass"}', cost: cost("reviewer", 3) }),
      },
      applyProductRules: false,
    });
    await Effect.runPromise(
      Effect.provideService(
        reviewer.review(draft("Menurut QS. 2:255 …"), context([chunk("QS. 2:255")])) as never,
        RunContext,
        { config: {}, now: () => 1, record: (e: never) => events.push(e) } as never,
      ) as never,
    );
    const review = events.find((e) => e.kind === "review");
    expect(review?.detail?.grounded).toEqual(["QS. 2:255"]);
  });

  it("flags an unreadable reviewer verdict on the trace instead of silently passing (A3)", async () => {
    const events: { kind: string; detail?: { verdictParseFailed?: boolean } }[] = [];
    const { RunContext } = await import("@app/rag-core");
    const reviewer = createKajianQReviewer({
      provider: {
        generate: () =>
          Effect.succeed({
            text: "Rate limit exceeded. Please retry later.",
            cost: cost("reviewer", 3),
          }),
      },
      applyProductRules: false,
    });
    const out = (await Effect.runPromise(
      Effect.provideService(
        reviewer.review(draft("Menurut QS. 2:255 …"), context([chunk("QS. 2:255")])) as never,
        RunContext,
        { config: {}, now: () => 1, record: (e: never) => events.push(e) } as never,
      ) as never,
    )) as { text: string };
    // The answer is still delivered (the deterministic gate passed), but the trace must
    // distinguish "unreadable" from "reviewer passed".
    expect(out.text).toContain("QS. 2:255");
    const review = events.find((e) => e.kind === "review");
    expect(review?.detail?.verdictParseFailed).toBe(true);
  });

  it("does not flag a readable verdict as unparseable", async () => {
    const events: { kind: string; detail?: { verdictParseFailed?: boolean } }[] = [];
    const { RunContext } = await import("@app/rag-core");
    const reviewer = createKajianQReviewer({
      provider: {
        generate: () => Effect.succeed({ text: '{"verdict":"pass"}', cost: cost("reviewer", 3) }),
      },
      applyProductRules: false,
    });
    await Effect.runPromise(
      Effect.provideService(
        reviewer.review(draft("Menurut QS. 2:255 …"), context([chunk("QS. 2:255")])) as never,
        RunContext,
        { config: {}, now: () => 1, record: (e: never) => events.push(e) } as never,
      ) as never,
    );
    const review = events.find((e) => e.kind === "review");
    expect(review?.detail?.verdictParseFailed).toBeUndefined();
  });
});

describe("parseReviewerVerdict", () => {
  it("reads a well-formed JSON envelope", async () => {
    const { parseReviewerVerdict } = await import("./chat-reviewer");
    expect(parseReviewerVerdict('{"verdict":"fail","reason":"x"}')).toEqual({
      verdict: "fail",
      parseFailed: false,
    });
    expect(parseReviewerVerdict('{"verdict":"pass"}')).toEqual({
      verdict: "pass",
      parseFailed: false,
    });
  });

  it("reads a raw-text verdict signal even when the envelope is truncated", async () => {
    const { parseReviewerVerdict } = await import("./chat-reviewer");
    expect(parseReviewerVerdict('{"verdict": "fail", "reason": "cut off')).toEqual({
      verdict: "fail",
      parseFailed: false,
    });
  });

  it("marks text with no verdict at all as unparseable (never a silent pass)", async () => {
    const { parseReviewerVerdict } = await import("./chat-reviewer");
    expect(parseReviewerVerdict("Rate limit exceeded. Please retry later.")).toEqual({
      verdict: "pass",
      parseFailed: true,
    });
    expect(parseReviewerVerdict("")).toEqual({ verdict: "pass", parseFailed: true });
  });
});

describe("runChatPipeline — end-to-end trace", () => {
  it("persists chunks with scores and every LLM call's cost on the trace", async () => {
    const { runStoreEffect } = await import("./chat-pipeline");
    void runStoreEffect;
    const store = {
      similaritySearch: () =>
        Effect.succeed([
          {
            child: {
              id: "chunk-1",
              textAr: "evidence",
              textId: null,
              metadata: { citation: "QS. 2:255", sourceType: "quran" },
            },
            distance: 0.2,
            rankDense: 1,
          },
        ]),
      // ADR-0049: the fused hit is a verse, so the neighbourhood read is asked for — the
      // fake must implement the seam even though it contributes nothing here.
      listDocChildNeighboursByChildIds: () => Effect.succeed([]),
    };
    const answer = await Effect.runPromise(
      runChatPipeline(
        {
          ...createStubChatProviders({ answerText: "Jawaban QS. 2:255" }),
          store: store as never,
          bridge: (e) => Effect.runPromise(e as never),
          language: "id",
          retrieval: {},
        },
        { text: "Apa itu Ayat Kursi?" },
      ) as never,
    );
    const trace = (answer as { trace: { events: never[] } }).trace;
    const retrieval = trace.events.find(
      (e: never) => (e as { kind: string }).kind === "retrieval",
    ) as { detail: { chunks: { id: string; score?: number }[] } } | undefined;
    expect(retrieval?.detail.chunks).toHaveLength(1);
    expect(retrieval?.detail.chunks[0]?.id).toBe("chunk-1");
    expect(typeof retrieval?.detail.chunks[0]?.score).toBe("number");

    const calls = trace.events.filter(
      (e: never) => (e as { kind: string }).kind === "llm_call",
    ) as unknown as { cost?: { modelId: string; tokensIn: number; tokensOut: number } }[];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.cost?.modelId).toBeTruthy();
      expect(typeof call.cost?.tokensIn).toBe("number");
      expect(typeof call.cost?.tokensOut).toBe("number");
    }
  });
});

/**
 * INTEGRATION — the trust invariant on the path the wiring runs: an answerable
 * question whose named evidence is in the assembled context must not ship a
 * refusal, and a trap question that names no citation address keeps its
 * refusal. The generator's first reading is scripted to decline in both cases;
 * only the addressed case gets the directed second reading, and the trace is
 * the signal the eval harness reads.
 */
describe("runChatPipeline — the addressed-evidence invariant", () => {
  const refusal = DEFAULT_REFUSALS.id;
  const ARABIC = "وَمَا أُمِرُوا إِلَّا لِيَعْبُدُوا اللَّهَ";
  const TRANSLATION = "Mereka tidak diperintah, kecuali untuk menyembah Allah …";
  const question = "Jelaskan perbedaan niat dan ikhlas berdasarkan QS. 98:5!";

  /** Seed one corpus chunk exactly as ingestion writes it. */
  async function seedChild(
    store: ReturnType<typeof createMemoryRagStore>,
    metadata: Record<string, unknown>,
    ordinal: number,
  ): Promise<string> {
    const parentId = await Effect.runPromise(
      store.insertDocParent({
        sourceKey: `source/${String(metadata["sourceType"])}`,
        title: String(metadata["citation"] ?? "Source"),
        metadata: {},
      }),
    );
    return Effect.runPromise(
      store.insertDocChild({
        parentId,
        textRaw: ARABIC,
        textAr: ARABIC,
        textId: TRANSLATION,
        citation: { sourceType: String(metadata["sourceType"]) },
        embeddingPrimary: [1, 0, 0],
        embeddingFallback: [1, 0, 0],
        ordinal,
        metadata,
      }),
    );
  }

  type PipelineAnswer = {
    text: string;
    trace: { events: { kind: string; stage?: string; detail?: Record<string, unknown> }[] };
    generatorCalls: readonly (readonly { role: string; content: string }[])[];
  };

  const run = async (
    store: ReturnType<typeof createMemoryRagStore>,
    replies: readonly string[],
    text: string,
  ): Promise<PipelineAnswer> => {
    const stubs = createStubChatProviders({ generatorReplies: replies });
    const answer = (await Effect.runPromise(
      runChatPipeline(
        {
          ...stubs,
          store: store as never,
          bridge: (e) => Effect.runPromise(e as never),
          language: "id",
          retrieval: {},
        },
        { text },
      ) as never,
    )) as { text: string; trace: PipelineAnswer["trace"] };
    return { ...answer, generatorCalls: stubs.generatorCalls };
  };

  const generatorPurposes = (answer: PipelineAnswer): unknown[] =>
    answer.trace.events
      .filter((e) => e.kind === "llm_call" && e.stage === "generator")
      .map((e) => e.detail?.["purpose"]);

  /** The user turn each generator call actually delivered — what the provider
   * was asked to read, which is where the directive has to be visible. */
  const deliveredPrompts = (answer: PipelineAnswer): string[] =>
    answer.generatorCalls.map((turns) => turns.at(-1)?.content ?? "");

  it("answers when the named verse is in the context and the first reading declined", async () => {
    const store = createMemoryRagStore();
    await seedChild(store, { citation: "QS. 98:5", sourceType: "quran", surah: 98, ayah: 5 }, 0);
    const answer = await run(store, [refusal, "Menurut QS. 98:5, ikhlas adalah …"], question);

    // The shipped text is the answer, and the trace records no refusal — the
    // exact two signals the eval scores.
    expect(answer.text).toContain("QS. 98:5");
    expect(answer.trace.events.some((e) => e.kind === "refusal")).toBe(false);
    expect(generatorPurposes(answer)).toEqual(["generate", "generate_addressed_reread"]);
    // The delivered second reading carries the directive and the first does not:
    // this test observes the prompt the provider received, so removing the
    // directive from the path fails it even while the purpose label survives.
    const directive = ADDRESSED_EVIDENCE_PROMPT.id("QS. 98:5");
    const prompts = deliveredPrompts(answer);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain(directive);
    expect(prompts[1]).toContain(directive);
    expect(prompts[1]).toMatch(/"tidak menemukan dalil yang memadai" tetap berlaku/);
  });

  it("keeps the refusal for a trap question that names no address", async () => {
    const store = createMemoryRagStore();
    await seedChild(
      store,
      {
        citation: "HR. Ibn Majah no. 224",
        sourceType: "hadith",
        collection: "ibnmajah",
        hadithNo: "224",
        grade: "dhaif",
      },
      0,
    );
    const trapQuestion =
      "Sebutkan hadits yang memerintahkan mencari ilmu sampai ke negeri China dan jelaskan sanadnya!";
    const answer = await run(store, [refusal, refusal], trapQuestion);

    expect(answer.text).toBe(refusal);
    const refusalEvents = answer.trace.events.filter((e) => e.kind === "refusal");
    expect(refusalEvents).toHaveLength(1);
    expect(refusalEvents[0]?.detail).toMatchObject({ trigger: "generator_refusal" });
    // The trap never gets the addressed reread: its second reading is the plain
    // ADR-0055 one, so the dhaif trap's behaviour is unchanged — and the two
    // delivered prompts are the same turn, not merely the same purpose label.
    const prompts = deliveredPrompts(answer);
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[1]).not.toContain("tetap berlaku");
    expect(generatorPurposes(answer)).toEqual(["generate", "generate_reread"]);
  });
});
