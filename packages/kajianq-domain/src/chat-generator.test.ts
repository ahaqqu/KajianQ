import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { RunContext, type AssembledContext, type Chunk } from "@app/rag-core";
import type { CostRecord } from "@app/contracts";
import { createKajianQGenerator } from "./chat-generator";
import { createKajianQReviewer } from "./chat-reviewer";
import type { KajianQFilters } from "./filters";
import { runChatPipeline } from "./chat-pipeline";
import { createStubChatProviders } from "./test-utils/stub-chat-providers";

/**
 * Generator + reviewer behavior (ticket #10): the generator streams from the
 * provider seam and settles the call's cost into the trace; the reviewer's
 * deterministic citation gate refuses ungrounded answers regardless of the
 * LLM reviewer's availability or verdict. The last block runs the real
 * five-stage pipeline through `runPipeline` so the trace assertions cover the
 * runner's own wiring, not a hand-built context.
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
  intent = "Apa itu Ayat Kursi?",
): AssembledContext<KajianQFilters> => ({
  query: { intent, subQueries: [{ text: intent }], filters: {} },
  chunks,
  turns: [{ role: "user", content: chunks.map((c) => c.text).join("\n") }],
});

const chunk = (label: string): Chunk => ({
  id: `c-${label}`,
  text: "evidence",
  metadata: { citation: label },
});

/**
 * Run one stage effect with a minimal `RunContext` (the stage's required
 * service). The trace sink is a no-op here — tests that assert on recorded
 * events provide their own context.
 */
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
    // The cost must land on the trace even though it settles only after the
    // stream completes (traceability rule 4).
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
            // Vendor rate-limit text: no verdict anywhere in the reply.
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
    // The answer is still delivered (the deterministic gate passed), but the
    // trace distinguishes "unreadable" from "reviewer passed".
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
    // router + generator (+ reviewer stub) — each with model identity + tokens.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.cost?.modelId).toBeTruthy();
      expect(typeof call.cost?.tokensIn).toBe("number");
      expect(typeof call.cost?.tokensOut).toBe("number");
    }
  });
});
