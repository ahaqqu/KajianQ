import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  embedDirectionStats,
  embedExpansionAccuracy,
  parseEmbedBenchRun,
  type EmbedBenchRun,
  type EmbedBenchRunRecord,
} from "@app/contracts";
import { parseExpansionSet, parseProbeSet } from "./embed-bench-fixtures";
import {
  buildEmbedBenchRun,
  embedBenchRunFilePath,
  embedBenchRunSlug,
  embedBenchSamplesPin,
  loadEmbedBenchRuns,
  loadEmbedBenchSeal,
  writeEmbedBenchRun,
} from "./embed-bench-store";

const PROBES_PATH = fileURLToPath(
  new URL("../../../benchmarks/embeddings/samples/probes.json", import.meta.url),
);
const EXPANSION_PATH = fileURLToPath(
  new URL("../../../benchmarks/embeddings/samples/expansion-cases.json", import.meta.url),
);
const SEAL_PATH = fileURLToPath(
  new URL("../../../benchmarks/embeddings/samples/version.json", import.meta.url),
);

const GATE_FLOOR_KEYS = {
  "secondary→primary": 0.7,
  "primary→primary": 0.75,
} as const;

const PROBES = parseProbeSet(JSON.parse(readFileSync(PROBES_PATH, "utf8")), PROBES_PATH);
const EXPANSION = parseExpansionSet(
  JSON.parse(readFileSync(EXPANSION_PATH, "utf8")),
  EXPANSION_PATH,
);

/** One record whose `passed` agrees with its own top-k evidence. */
const rec = (
  probeId: string,
  direction: EmbedBenchRunRecord["direction"],
  passed: boolean,
  over: Partial<EmbedBenchRunRecord> = {},
): EmbedBenchRunRecord => ({
  probeId,
  direction,
  expected: direction === "expansion" ? "term-a" : ["d1", "d2"],
  got: passed ? ["d1", "d2", "d3"] : ["d3", "d4"],
  passed,
  ...over,
});

/** Records for one arm: two cross-lingual probes (one partial miss) + two expansion cases. */
const RECORDS: EmbedBenchRunRecord[] = [
  rec("xl-1", "secondary→primary", true),
  rec("xl-2", "secondary→primary", false, { got: ["d1", "d3"] }),
  rec("exp-1", "expansion", true, {
    cost: { modelId: "m", tokensIn: 10, tokensOut: 1, latencyMs: 30, costMicroUsd: 2 },
  }),
  rec("exp-2", "expansion", false, { expected: "term-b", got: ["term-c"] }),
];

/** A minimal self-consistent run for one arm, overridable per test. */
const runOf = (model: string, over: Partial<EmbedBenchRun> = {}): EmbedBenchRun => {
  const records = over.records ?? RECORDS;
  const stats = embedDirectionStats(records);
  const pick = (key: "probes" | "recallAt10" | "mrr") =>
    Object.fromEntries(Object.entries(stats).map(([d, s]) => [d, s[key]]));
  const failedDirections = Object.entries(GATE_FLOOR_KEYS)
    .filter(([d, floor]) => (stats[d]?.recallAt10 ?? 0) < floor)
    .map(([d]) => d);
  return {
    schema: 1,
    task: "embed-bench",
    model,
    samples: {
      version: 1,
      probesSha256: "sha256:826bfc0d",
      expansionSha256: "sha256:98efedc5",
      corpusFingerprint: "fnv1a64:test:9",
    },
    budget: { capMicroUsd: null, plannedCalls: 9, totalMicroUsd: 4 },
    totals: {
      probes: pick("probes") as Record<string, number>,
      recallAt10: pick("recallAt10"),
      mrr: pick("mrr"),
      expansionAccuracy: embedExpansionAccuracy(records),
    },
    gate: {
      gatePass: failedDirections.length === 0,
      failedDirections,
      floors: { crossLingual: 0.7, monolingual: 0.75 },
    },
    startedAt: "2026-11-14T00:00:00.000Z",
    finishedAt: "2026-11-14T00:00:01.000Z",
    records,
    ...over,
  };
};

describe("embed-bench store — the committed seal", () => {
  it("the committed seal verifies against the committed sample bytes", () => {
    const seal = loadEmbedBenchSeal(SEAL_PATH, PROBES_PATH, EXPANSION_PATH, PROBES, EXPANSION);
    expect(seal.version).toBe(1);
    expect(seal.task).toBe("embed-bench");
    expect(seal.counts).toEqual({ crossLingual: 200, monolingual: 200, expansion: 12 });
    expect(seal.fixtures.probes.id).toBe(PROBES.id);
    expect(seal.fixtures.expansion.id).toBe(EXPANSION.id);
  });

  it("the seal's corpus fingerprint is the probe fixture's own pin", () => {
    const seal = loadEmbedBenchSeal(SEAL_PATH, PROBES_PATH, EXPANSION_PATH, PROBES, EXPANSION);
    expect(seal.fingerprints.corpus).toBe(PROBES.corpusFingerprint);
  });

  it("sample bytes that no longer match the seal fail before any spend", () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-bench-store-"));
    try {
      const tampered = join(dir, "probes.json");
      writeFileSync(
        tampered,
        readFileSync(PROBES_PATH, "utf8").replace("crossLingual", "crossLingua"),
      );
      expect(() =>
        loadEmbedBenchSeal(SEAL_PATH, tampered, EXPANSION_PATH, PROBES, EXPANSION),
      ).toThrow(/probes hash mismatch.*re-seal before running/);
      const tamperedExpansion = join(dir, "expansion-cases.json");
      writeFileSync(
        tamperedExpansion,
        readFileSync(EXPANSION_PATH, "utf8").replace("expectedTerm", "expectedTerms"),
      );
      expect(() =>
        loadEmbedBenchSeal(SEAL_PATH, PROBES_PATH, tamperedExpansion, PROBES, EXPANSION),
      ).toThrow(/expansion hash mismatch.*re-seal before running/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a probe fixture pinning a different corpus than the seal fails", () => {
    const drifted = { ...PROBES, corpusFingerprint: "fnv1a64:elsewhere:9" };
    expect(() =>
      loadEmbedBenchSeal(SEAL_PATH, PROBES_PATH, EXPANSION_PATH, drifted, EXPANSION),
    ).toThrow(/corpus fingerprint mismatch.*re-seal before running/);
  });

  it("counts that disagree with the fixtures fail", () => {
    const short = { ...PROBES, crossLingual: PROBES.crossLingual.slice(1) };
    expect(() =>
      loadEmbedBenchSeal(SEAL_PATH, PROBES_PATH, EXPANSION_PATH, short, EXPANSION),
    ).toThrow(/counts\.crossLingual 200 does not match the fixture's 199/);
  });
});

describe("embed-bench store — run files", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "embed-bench-runs-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("slugifies a model id once, slashes and tildes included", () => {
    expect(embedBenchRunSlug("~acme/embed-latest")).toBe("acme-embed-latest");
    expect(embedBenchRunSlug("acme/embed-v1.5")).toBe("acme-embed-v1-5");
    expect(embedBenchRunFilePath("/runs", "~acme/embed-latest")).toBe(
      join("/runs", "acme-embed-latest.json"),
    );
  });

  it("writes a run once, refuses an overwrite without force, replaces with it", () => {
    writeEmbedBenchRun(dir, runOf("a/one"));
    expect(readFileSync(embedBenchRunFilePath(dir, "a/one"), "utf8")).toMatch(/"a\/one"/);
    expect(() => writeEmbedBenchRun(dir, runOf("a/one"))).toThrow(/already exists.*--force/);
    writeEmbedBenchRun(
      dir,
      runOf("a/one", { budget: { capMicroUsd: null, plannedCalls: 9, totalMicroUsd: 7 } }),
      {
        force: true,
      },
    );
    expect(readFileSync(embedBenchRunFilePath(dir, "a/one"), "utf8")).toContain(
      '"totalMicroUsd": 7',
    );
  });

  it("loads committed runs in file-name order and refuses a stale samples pin", () => {
    const seal = loadEmbedBenchSeal(SEAL_PATH, PROBES_PATH, EXPANSION_PATH, PROBES, EXPANSION);
    const pin = embedBenchSamplesPin(seal);
    writeEmbedBenchRun(dir, runOf("b/two", { samples: pin }));
    writeEmbedBenchRun(dir, runOf("a/one", { samples: pin }));
    expect(loadEmbedBenchRuns(dir, seal).map((r) => r.model)).toEqual(["a/one", "b/two"]);
    writeEmbedBenchRun(dir, runOf("c/stale", { samples: { ...pin, version: 2 } }), { force: true });
    expect(() => loadEmbedBenchRuns(dir, seal)).toThrow(
      /pins samples v2.*archive it under superseded/,
    );
  });

  it("the samples pin carries the seal's version, both hashes and the fingerprint", () => {
    const seal = loadEmbedBenchSeal(SEAL_PATH, PROBES_PATH, EXPANSION_PATH, PROBES, EXPANSION);
    expect(embedBenchSamplesPin(seal)).toEqual({
      version: seal.version,
      probesSha256: seal.hashes.probes,
      expansionSha256: seal.hashes.expansion,
      corpusFingerprint: seal.fingerprints.corpus,
    });
  });

  it("a built arm round-trips through write, parse and the pin check", () => {
    const seal = loadEmbedBenchSeal(SEAL_PATH, PROBES_PATH, EXPANSION_PATH, PROBES, EXPANSION);
    const run = buildEmbedBenchRun({
      model: "a/built",
      startedAt: "2026-11-14T00:00:00.000Z",
      samples: embedBenchSamplesPin(seal),
      budget: { capMicroUsd: 5000000, plannedCalls: 413, totalMicroUsd: 7 },
      floors: { crossLingual: 0.7, monolingual: 0.75 },
      cells: [
        {
          direction: "secondary→primary",
          queries: 1,
          recallAtK: 1,
          mrr: 1,
          probeOutcomes: [
            { queryId: "xl-1", expectedIds: ["d1"], rankedTopK: ["d1", "d2"], passed: true },
          ],
        },
      ],
      expansionResults: [
        {
          caseId: "exp-1",
          correct: true,
          picked: ["term-a"],
          expectedTerm: "term-a",
          cost: { modelId: "m", tokensIn: 10, tokensOut: 2, latencyMs: 25, costMicroUsd: 3 },
        },
      ],
    });
    writeEmbedBenchRun(dir, run);
    const loaded = loadEmbedBenchRuns(dir, seal);
    expect(loaded.map((r) => r.model)).toEqual(["a/built"]);
    expect(loaded[0]!.totals.expansionAccuracy).toBe(1);
    // The unscored gate direction counts as failed — absence is never a pass.
    expect(loaded[0]!.gate).toEqual({
      gatePass: false,
      failedDirections: ["primary→primary"],
      floors: { crossLingual: 0.7, monolingual: 0.75 },
    });
    expect(loaded[0]!.records).toHaveLength(2);
  });

  it("a run whose totals disagree with its own records fails the parse", () => {
    const driftedProbes = runOf("a/one", {
      totals: {
        probes: { "secondary→primary": 3 },
        recallAt10: {},
        mrr: {},
        expansionAccuracy: null,
      },
    });
    expect(() => parseEmbedBenchRun(driftedProbes)).toThrow(
      /totals\.probes must describe exactly the run's record directions/,
    );
    const driftedRecall = runOf("a/one");
    driftedRecall.totals.recallAt10["secondary→primary"] = 0.9;
    expect(() => parseEmbedBenchRun(driftedRecall)).toThrow(
      /totals\.recallAt10\["secondary→primary"\] 0.9 does not match the records' 0.75/,
    );
    const driftedAccuracy = runOf("a/one");
    driftedAccuracy.totals.expansionAccuracy = 1;
    expect(() => parseEmbedBenchRun(driftedAccuracy)).toThrow(
      /totals\.expansionAccuracy 1 does not match the expansion records' 0.5/,
    );
  });

  it("a retrieval record whose passed flag disagrees with its recall fails the parse", () => {
    const liar = runOf("a/one", {
      records: [rec("xl-1", "secondary→primary", true, { got: ["d3", "d4"] })],
    });
    expect(() => parseEmbedBenchRun(liar)).toThrow(/passed true disagrees with its top-k recall/);
  });

  it("a gate verdict that does not follow from the floors fails the parse", () => {
    const wrongMisses = runOf("a/one", {
      gate: {
        gatePass: false,
        failedDirections: [],
        floors: { crossLingual: 0.7, monolingual: 0.75 },
      },
    });
    expect(() => parseEmbedBenchRun(wrongMisses)).toThrow(
      /gate\.failedDirections \[\] does not match the floors' verdict/,
    );
    const wrongPass = runOf("a/one", {
      gate: {
        gatePass: true,
        failedDirections: ["primary→primary"],
        floors: { crossLingual: 0.7, monolingual: 0.75 },
      },
    });
    expect(() => parseEmbedBenchRun(wrongPass)).toThrow(
      /gatePass true disagrees with 1 failed direction/,
    );
  });

  it("an aborted run must name its failure and a complete one carries none", () => {
    expect(() => parseEmbedBenchRun(runOf("a/one", { aborted: true }))).toThrow(
      /aborted without an error message/,
    );
    expect(() => parseEmbedBenchRun(runOf("a/one", { error: "vendor 500" }))).toThrow(
      /carries an error but is not aborted/,
    );
  });
});
