import { describe, expect, it } from "vite-plus/test";
import { assembleReportDocument, countByRule, evaluateGates } from "./sanadset-report";
import { renderReportMarkdown } from "./sanadset-report-markdown";
import type { StudyFacts } from "./sanadset-report-types";

/**
 * Test intent, named before the assertions:
 * - trap: the document must satisfy `IngestionReportSchema`, so an artifact that drifts
 *   from the contract never reaches disk;
 * - trap: a gate S1 cannot measure must read `not-measured` with a reason — a proxy
 *   promoted to `pass` is how a study licenses a run it did not justify;
 * - trap: the in-slice match rate must never appear without its scope, or a reader will
 *   quote it as the corpus reconciliation rate.
 */

function facts(overrides: Partial<StudyFacts> = {}): StudyFacts {
  const base: StudyFacts = {
    schemaVersion: 1,
    runId: "s1-test",
    command: "bun study:sanadset --no-model",
    source: { fileName: "sanadset.csv", bytes: 10, sha256: "a".repeat(64), recordsRead: 10 },
    slice: {
      books: ["صحيح البخاري", "صحيح مسلم"],
      rows: 10,
      noSanad: 1,
      quarantined: 1,
      prepared: 8,
      repeatedNameChains: 0,
      unbalancedTagRows: 0,
      byBook: {
        "صحيح البخاري": { rows: 5, noSanad: 0, quarantined: 0, processed: 5 },
        "صحيح مسلم": { rows: 5, noSanad: 1, quarantined: 1, processed: 4 },
      },
    },
    narrator: {
      mentions: 100,
      rawDistinct: 60,
      foldedDistinct: 50,
      foldedVariants: 10,
      singletonClusters: 20,
      singletonMentions: 20,
      resolvedMentions: 80,
      resolutionRate: 0.8,
      blockingKeys: 50,
      multiNameBlockingKeys: 5,
      bandNames: 10,
      candidatePairs: 12,
      largestBlockingGroup: 3,
    },
    matn: {
      preparedRows: 8,
      groups: 6,
      distinctMatns: 6,
      chainsPerChild: 10 / 6,
      matchRate: { scope: "slice-internal", matchedRows: 2, rows: 8, value: 0.25 },
      byBook: {
        "صحيح البخاري": { scope: "slice-internal", matchedRows: 1, rows: 5, value: 0.2 },
        "صحيح مسلم": { scope: "slice-internal", matchedRows: 1, rows: 4, value: 0.25 },
      },
      byKind: { exact: 1, folded: 1, trigram: 1, "no-match": 5 },
      candidateCapHits: 0,
    },
    band: {
      matnRows: 1,
      narratorPairs: 12,
      narratorNames: 10,
      callsNeeded: 301,
      callsBudgeted: 301,
      ceiling: 6000,
    },
    quarantine: { total: 1, byRule: { implausible_chain_length: 1 } },
    modelArm: {
      provider: "dashscope",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      model: "qwen3.7-flash",
      keyPresent: false,
      keySource: "absent",
      keyDetail: "DASHSCOPE_API_KEY unset",
      price: { inputUsdPerMTok: 0.03, outputUsdPerMTok: 0.13 },
      ran: false,
      stopReason: "not-requested",
      requests: 0,
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      estimatedTokens: false,
      spendMicroUsd: 0,
      estimate: { calls: 10, tokensIn: 100, tokensOut: 20, costMicroUsd: 3, estimated: true },
      samplePredictions: 0,
    },
    sample: {
      seed: 7,
      requested: 300,
      selected: 12,
      shortfall: 288,
      composition: [],
      labelsPresent: false,
    },
    gates: [],
    limits: ["one limitation"],
    timings: { startedAt: 1, finishedAt: 2, wallClockMs: 1 },
  };
  return { ...base, ...overrides };
}

describe("assembleReportDocument", () => {
  it("produces a document that satisfies the ingestion contract", () => {
    const document = assembleReportDocument({ facts: facts(), costRecords: [], quarantined: 1 });
    expect(document.report.runId).toBe("s1-test");
    expect(document.report.sourceKey).toBe(`sanadset:s1:${"a".repeat(12)}`);
    expect(document.report.parentsWritten).toBe(0);
    expect(document.report.childrenWritten).toBe(0);
    expect(document.report.quarantined).toBe(1);
    expect(document.report.llmCalls).toEqual([]);
    expect(document.report.details?.["study"]).toBe(document.study);
  });

  it("carries the arm's calls as cost records and sums the spend", () => {
    const document = assembleReportDocument({
      facts: facts({
        modelArm: {
          ...facts().modelArm,
          ran: true,
          calls: 2,
          requests: 2,
          tokensIn: 500,
          tokensOut: 40,
          spendMicroUsd: 21,
        },
      }),
      costRecords: [
        {
          modelId: "qwen3.7-flash",
          tokensIn: 250,
          tokensOut: 20,
          latencyMs: 9,
          costMicroUsd: 10,
          estimated: false,
        },
        {
          modelId: "qwen3.7-flash",
          tokensIn: 250,
          tokensOut: 20,
          latencyMs: 8,
          costMicroUsd: 11,
          estimated: false,
        },
      ],
      quarantined: 1,
    });
    expect(document.report.llmCalls).toHaveLength(2);
    expect(document.report.costMicroUsd).toBe(21);
  });
});

describe("evaluateGates", () => {
  const base = {
    narratorRate: 0.97,
    quarantineShare: 0.02,
    spendMicroUsd: 0,
    capMicroUsd: 50_000_000,
    armRan: false,
  };

  it("passes the gates it can measure and refuses to pass the ones it cannot", () => {
    const gates = evaluateGates(base);
    const byId = new Map(gates.map((gate) => [gate.id, gate]));
    expect(byId.get("narrator-resolution")?.status).toBe("pass");
    expect(byId.get("quarantine-share")?.status).toBe("pass");
    expect(byId.get("spend-cap")?.status).toBe("pass");
    expect(byId.get("corpus-match-rate")?.status).toBe("not-measured");
    expect(byId.get("corpus-match-rate")?.reason).toContain("no database client");
    expect(byId.get("sampled-macro-f1")?.status).toBe("not-measured");
    expect(byId.get("false-merge-precision")?.status).toBe("not-measured");
  });

  it("never reports a pass without a measurement", () => {
    for (const gate of evaluateGates({ ...base, narratorRate: 0, quarantineShare: 1 })) {
      if (gate.status === "pass") expect(gate.measured).not.toBeNull();
      if (gate.measured === null) expect(gate.status).toBe("not-measured");
    }
  });

  it("fails the resolution gate and the quarantine gate on the measured values", () => {
    const byId = new Map(
      evaluateGates({ ...base, narratorRate: 0.8, quarantineShare: 0.109 }).map((gate) => [
        gate.id,
        gate,
      ]),
    );
    expect(byId.get("narrator-resolution")?.status).toBe("fail");
    expect(byId.get("quarantine-share")?.status).toBe("fail");
    expect(byId.get("quarantine-share")?.measured).toBe("10.90%");
  });

  it("fails the spend gate when the recorded spend passes the cap", () => {
    const byId = new Map(
      evaluateGates({ ...base, spendMicroUsd: 60_000_000 }).map((gate) => [gate.id, gate]),
    );
    expect(byId.get("spend-cap")?.status).toBe("fail");
  });
});

describe("countByRule", () => {
  it("counts rows per quarantine rule", () => {
    expect(countByRule([{ rule: "a" }, { rule: "a" }, { rule: "b" }])).toEqual({ a: 2, b: 1 });
    expect(countByRule([])).toEqual({});
  });
});

describe("renderReportMarkdown", () => {
  it("names the match-rate scope and repeats every limitation and gate", () => {
    const document = assembleReportDocument({
      facts: facts({
        gates: evaluateGates({
          narratorRate: 0.97,
          quarantineShare: 0.02,
          spendMicroUsd: 0,
          capMicroUsd: 50_000_000,
          armRan: false,
        }),
      }),
      costRecords: [],
      quarantined: 1,
    });
    const markdown = renderReportMarkdown(document);
    expect(markdown).toContain("scope **slice-internal**");
    expect(markdown).toContain("## Limitations");
    expect(markdown).toContain("one limitation");
    expect(markdown).toContain("corpus-match-rate");
    expect(markdown).toContain("not-measured");
    expect(markdown).toContain("pre-registered before any model output");
    expect(markdown).toContain("sanadset.csv");
  });
});
