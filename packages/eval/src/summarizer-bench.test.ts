import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { SummarizerBenchRun } from "@app/contracts";
import { checkSummarizerCase, runSummarizerBench } from "./summarizer-bench";
import { DECISION_GATE_FLOORS } from "./decision-bench";
import {
  loadSummarizerBenchRuns,
  loadSummarizerBenchSeal,
  summarizerBenchPromptsPin,
  summarizerBenchSamplesPin,
  writeSummarizerBenchRun,
} from "./summarizer-bench-store";
import { renderSummarizerBenchReport } from "./summarizer-bench-report";

const CASES_PATH = fileURLToPath(
  new URL("../../../benchmarks/summarization/samples/cases.json", import.meta.url),
);
const SEAL_PATH = fileURLToPath(
  new URL("../../../benchmarks/summarization/samples/version.json", import.meta.url),
);

const COST = {
  modelId: "fake/model",
  tokensIn: 200,
  tokensOut: 60,
  latencyMs: 800,
  costMicroUsd: 20,
};

const caseOf = (over: Partial<Parameters<typeof checkSummarizerCase>[0]> = {}) => ({
  id: "sm-x-01",
  kind: "surah",
  language: "id",
  sourceKey: "corpus/source/112",
  title: "سُورَةُ الْاِخْلَاص",
  excerpt: ["قُلْ هُوَ اللّٰهُ اَحَدٌۚ", "اَللّٰهُ الصَّمَدُۚ"],
  expected: { minSentences: 1, maxSentences: 3 },
  ...over,
});

const summaryOf = (over: Partial<SummarizerBenchRun> = {}): SummarizerBenchRun => ({
  schema: 1,
  task: "summarizer-bench",
  model: "fake/model",
  samples: { version: 1, casesSha256: "sha256:f045063e" },
  promptsSha256: "sha256:abc123",
  budget: { capMicroUsd: null, plannedCases: 2, totalMicroUsd: 40 },
  totals: { cases: 2, scored: 2, passed: 1, accuracy: 0.5 },
  gate: {
    gatePass: false,
    overallAccuracy: 0.5,
    failedLanguages: [],
    floors: { overall: 0.85, perLanguage: 0.75, minCasesPerLanguage: 3 },
  },
  startedAt: "2026-11-14T00:00:00.000Z",
  finishedAt: "2026-11-14T00:00:01.000Z",
  records: [
    {
      caseId: "sm-q-01",
      language: "id",
      expected: '{"minSentences":1,"maxSentences":3}',
      got: "Ringkasan pembuka buku.",
      passed: true,
      cost: COST,
    },
    {
      caseId: "sm-q-02",
      language: "id",
      expected: '{"minSentences":1,"maxSentences":3}',
      got: "Tema tidak jelas.",
      passed: false,
    },
  ],
  ...over,
});

describe("summarizer-bench deterministic checks", () => {
  /** The faithfulness read is a caller-supplied hook; these tests stub it. */
  const grounded = () => [];

  it("a clean 1-3 sentence summary with grounded content passes", () => {
    expect(
      checkSummarizerCase(
        caseOf(),
        "Surah ini menegaskan keesaan Allah sebagai tempat bergantung.",
        grounded,
      ),
    ).toBeNull();
  });

  it("sentence bounds fail the case in both directions", () => {
    expect(checkSummarizerCase(caseOf(), "", grounded)).toMatch(/empty summary/);
    expect(
      checkSummarizerCase(
        caseOf({ expected: { minSentences: 2, maxSentences: 3 } }),
        "Satu kalimat saja.",
        grounded,
      ),
    ).toMatch(/too few sentences/);
    expect(
      checkSummarizerCase(
        caseOf({ expected: { minSentences: 1, maxSentences: 1 } }),
        "Kalimat pertama. Kalimat kedua! Kalimat ketiga?",
        grounded,
      ),
    ).toMatch(/too many sentences/);
  });

  it("the caller's faithfulness read decides script-specific grounding", () => {
    const ungrounded = (_c: unknown, summary: string) =>
      summary.includes("invented") ? ['ungrounded token "invented"'] : [];
    expect(checkSummarizerCase(caseOf(), "Menyebut invented tanpa dasar.", ungrounded)).toMatch(
      /ungrounded token "invented"/,
    );
    expect(
      checkSummarizerCase(caseOf(), "Surah ini menegaskan keesaan Allah.", ungrounded),
    ).toBeNull();
  });

  it("numerals must ground in the excerpt or the case metadata", () => {
    expect(checkSummarizerCase(caseOf(), "Bagian 112 tentang keesaan.", grounded)).toBeNull();
    expect(checkSummarizerCase(caseOf(), "Terbagi atas 5 rukun.", grounded)).toMatch(
      /ungrounded numeral "5"/,
    );
  });

  it("mustMention terms are required when the case asserts them", () => {
    expect(
      checkSummarizerCase(
        caseOf({ expected: { minSentences: 1, maxSentences: 3, mustMention: ["tawhid"] } }),
        "Tema tawhid.",
        grounded,
      ),
    ).toBeNull();
    expect(
      checkSummarizerCase(
        caseOf({ expected: { minSentences: 1, maxSentences: 3, mustMention: ["tawhid"] } }),
        "Tema lain.",
        grounded,
      ),
    ).toMatch(/missing required term/);
  });

  it("the engine runs the loop through the adapter, surfacing cost and the summary verbatim", async () => {
    const fixture = {
      id: "f",
      status: "v0-draft",
      cases: [caseOf()],
    } as never;
    const outcomes = await runSummarizerBench({
      provider: {
        generate: () => Effect.succeed({ text: "Surah ini menegaskan keesaan Allah.", cost: COST }),
      } as never,
      fixture,
      adapters: {
        buildPrompt: (c) => ({ turns: [{ role: "user", content: c.title }] }),
        ungrounded: grounded,
      },
      onCost: () => {},
      wouldExceed: () => false,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.passed).toBe(true);
    expect(outcomes[0]?.got).toBe("Surah ini menegaskan keesaan Allah.");
    expect(outcomes[0]?.cost).toEqual(COST);
  });
});

describe("summarizer-bench store — the committed seal", () => {
  const fixture = JSON.parse(readFileSync(CASES_PATH, "utf8")) as Parameters<
    typeof loadSummarizerBenchSeal
  >[2];

  it("the committed seal verifies against the committed case bytes", () => {
    const seal = loadSummarizerBenchSeal(SEAL_PATH, CASES_PATH, fixture);
    expect(seal.version).toBe(1);
    expect(seal.task).toBe("summarizer-bench");
    expect(seal.counts.cases).toBe(fixture.cases.length);
  });

  it("cases bytes that no longer match the seal fail before any spend", () => {
    const dir = mkdtempSync(join(tmpdir(), "summarizer-bench-seal-"));
    try {
      const tampered = join(dir, "cases.json");
      writeFileSync(tampered, readFileSync(CASES_PATH, "utf8").replace("v0-draft", "v0-draf"));
      expect(() => loadSummarizerBenchSeal(SEAL_PATH, tampered, fixture)).toThrow(
        /cases hash mismatch.*re-seal before running/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("summarizer-bench store — run files", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "summarizer-bench-runs-"));
    mkdirSync(join(dir, "runs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const runsDir = () => join(dir, "runs");
  const seal = {
    task: "summarizer-bench",
    version: 1,
    created: "2026-11-13T23:40:28Z",
    fixture: { id: "summarizer-bench-v0", status: "v0-draft" },
    counts: { cases: 5 },
    languages: { id: 5 },
    hashes: { cases: "sha256:f045063e" },
  };

  it("writes a run once, refuses an overwrite without force, replaces with it", () => {
    writeSummarizerBenchRun(runsDir(), summaryOf({}));
    expect(readFileSync(join(runsDir(), "fake-model.json"), "utf8")).toMatch(/"fake\/model"/);
    expect(() => writeSummarizerBenchRun(runsDir(), summaryOf({}))).toThrow(
      /already exists.*--force/,
    );
    writeSummarizerBenchRun(runsDir(), summaryOf({ promptsSha256: "sha256:re-run" }), {
      force: true,
    });
    expect(readFileSync(join(runsDir(), "fake-model.json"), "utf8")).toContain("re-run");
  });

  it("loads committed runs in file-name order and refuses a stale samples pin", () => {
    writeSummarizerBenchRun(runsDir(), summaryOf({ model: "b/two" }));
    writeSummarizerBenchRun(runsDir(), summaryOf({ model: "a/one" }));
    const runs = loadSummarizerBenchRuns(runsDir(), seal);
    expect(runs.map((r) => r.model)).toEqual(["a/one", "b/two"]);
    writeSummarizerBenchRun(
      runsDir(),
      summaryOf({
        model: "c/stale",
        samples: { version: 2, casesSha256: "sha256:different-bytes" },
      }),
      { force: true },
    );
    expect(() => loadSummarizerBenchRuns(runsDir(), seal)).toThrow(
      /pins samples v2.*archive it under superseded/,
    );
  });

  it("the samples pin and prompts pin are deterministic", () => {
    expect(summarizerBenchSamplesPin(seal)).toEqual({ version: 1, casesSha256: "sha256:f045063e" });
    expect(summarizerBenchPromptsPin("wording")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(summarizerBenchPromptsPin("wording")).toBe(summarizerBenchPromptsPin("wording"));
  });
});

describe("summarizer-bench report", () => {
  const render = (runs: SummarizerBenchRun[], supersededCount = 0) =>
    renderSummarizerBenchReport({
      seal: {
        task: "summarizer-bench",
        version: 1,
        created: "2026-11-13T23:40:28Z",
        fixture: { id: "summarizer-bench-v0", status: "v0-draft" },
        counts: { cases: 5 },
        languages: { id: 5 },
        hashes: { cases: "sha256:f045063e" },
        notes: ["The gate scores what is deterministic."],
      },
      runs,
      runsDir: "benchmarks/summarization/runs",
      generatedAt: "2026-11-14T00:00:02.000Z",
      supersededCount,
    });

  it("an empty store renders the unmeasured state, honestly", () => {
    const md = render([]);
    expect(md).toContain("# Summarizer benchmark report");
    expect(md).toContain("never hand-edited");
    expect(md).toContain(`overall ≥ ${DECISION_GATE_FLOORS.overall}`);
    expect(md).toContain("theme quality stays the owner's call");
    expect(md).toContain("No runs at the committed seal yet");
    expect(md).toContain("No arm passes the gate at this seal.");
  });

  it("arms are derived from records and every summary is printed for the owner's read", () => {
    const md = render([summaryOf({})]);
    expect(md).toContain("| `fake/model` |");
    expect(md).toContain("| 50.0% |");
    expect(md).toContain("**fail** |");
    expect(md).toContain("recomputed from each run's records");
    expect(md).toContain("## Summaries (the evidence for the owner's read)");
    expect(md).toContain('"Ringkasan pembuka buku."');
    expect(md).toContain("- `fake/model` (1): `sm-q-02`");
  });

  it("an aborted run is evidence, never a pass", () => {
    const aborted = { ...summaryOf({}), aborted: true, error: "vendor 500" };
    const md = render([aborted]);
    expect(md).toContain("⚠ aborted (vendor 500)");
    expect(md).toContain("No arm passes the gate at this seal.");
  });

  it("the superseded history line renders when the archive is non-empty", () => {
    expect(render([], 1)).toContain("## Superseded");
  });
});
