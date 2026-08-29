import { describe, expect, it } from "vitest";
import { parseTrace, type CostRecord } from "@app/contracts";
import type { Stage, TraceEvent } from "@app/contracts";
import type {
  EmbedSpec,
  EmbeddingResult,
  GenerationResult,
  PromptSpec,
  Provider,
  StreamHandle,
} from "./provider";
import type { RunContext } from "./context";

function cost(modelId: string, tokensIn = 10, tokensOut = 20): CostRecord {
  return {
    modelId,
    tokensIn,
    tokensOut,
    latencyMs: 5,
    costMicroUsd: tokensIn * 100 + tokensOut * 200,
  };
}

/** Records `llm_call` events the way a real stage must (ADR-0021 rule 4). */
function recordingRun(): { run: RunContext<Record<string, unknown>>; events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  const run: RunContext<Record<string, unknown>> = {
    config: {},
    now: () => 1_000,
    record: (event) => events.push(event),
    defer: () => {},
  };
  return { run, events };
}

function fakeProvider(modelId: string): Provider {
  return {
    modelId,
    generate: async (_spec: PromptSpec): Promise<GenerationResult> => ({
      text: `answer from ${modelId}`,
      cost: cost(modelId),
    }),
    stream: async (_spec: PromptSpec): Promise<StreamHandle> => ({
      deltas: (async function* () {
        yield `answer from ${modelId}`;
      })(),
      cost: async () => cost(modelId),
    }),
    embed: async (spec: EmbedSpec): Promise<EmbeddingResult> => ({
      vectors: spec.texts.map(() => [0.1, 0.2]),
      cost: cost(modelId, spec.texts.length),
    }),
  };
}

describe("Provider seam", () => {
  it("every method returns a CostRecord carrying the model id", async () => {
    const provider = fakeProvider("m-generator");
    const gen = await provider.generate({ turns: [{ role: "system", content: "hi" }] });
    expect(gen.cost.modelId).toBe("m-generator");
    expect(gen.text).toBe("answer from m-generator");

    const handle = await provider.stream({ turns: [{ role: "user", content: "hi" }] });
    const chunks: string[] = [];
    for await (const delta of handle.deltas) chunks.push(delta);
    expect(chunks).toEqual(["answer from m-generator"]);
    expect((await handle.cost()).modelId).toBe("m-generator");

    const emb = await provider.embed({ texts: ["satu", "dua"] });
    expect(emb.vectors).toHaveLength(2);
    expect(emb.cost.modelId).toBe("m-generator");
  });

  it("a stage that records the returned cost produces a valid, parseable trace", async () => {
    const { run, events } = recordingRun();
    const provider = fakeProvider("m-generator");
    const stage: Stage = "generator";

    const gen = await provider.generate({ turns: [{ role: "user", content: "q" }] });
    run.record({ stage, kind: "llm_call", detail: { purpose: "generate" }, cost: gen.cost, at: run.now() });

    const trace = parseTrace({ id: "t1", createdAt: run.now(), events });
    expect(trace.events).toHaveLength(1);
    expect(trace.events[0]?.cost?.costMicroUsd).toBe(gen.cost.costMicroUsd);
  });

  it("a stream whose cost is awaited and recorded lands in the trace", async () => {
    const { run, events } = recordingRun();
    const provider = fakeProvider("m-router");
    const handle = await provider.stream({ turns: [{ role: "user", content: "q" }] });
    const text: string[] = [];
    for await (const delta of handle.deltas) text.push(delta);
    const recorded = await handle.cost();
    run.record({ stage: "router", kind: "llm_call", cost: recorded, at: run.now() });

    const trace = parseTrace({ id: "t2", createdAt: run.now(), events });
    expect(trace.events[0]?.cost?.tokensOut).toBe(recorded.tokensOut);
    expect(trace.events[0]?.cost?.tokensOut).toBeGreaterThan(0);
  });

  it("embedding cost is recorded with tokens counted per input text", async () => {
    const { run, events } = recordingRun();
    const provider = fakeProvider("m-embedder");
    const emb = await provider.embed({ texts: ["a", "b", "c"], dimensions: 1536 });
    run.record({ stage: "ingest", kind: "llm_call", cost: emb.cost, at: run.now() });

    const trace = parseTrace({ id: "t3", createdAt: run.now(), events });
    expect(emb.cost.tokensIn).toBe(3);
    expect(trace.events[0]?.cost?.tokensIn).toBe(3);
  });
});