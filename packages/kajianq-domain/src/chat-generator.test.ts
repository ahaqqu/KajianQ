import { Effect, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { ProviderError, RunContext, type AssembledContext, type Chunk } from "@app/rag-core";
import type { CostRecord } from "@app/contracts";
import { createKajianQGenerator, REFUSAL_REREAD_LIMIT } from "./chat-generator";
import { createKajianQReviewer } from "./chat-reviewer";
import type { KajianQFilters } from "./filters";
import { runChatPipeline } from "./chat-pipeline";
import { createStubChatProviders } from "./test-utils/stub-chat-providers";
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
