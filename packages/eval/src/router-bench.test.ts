import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { RouterBenchFixture, RouterBenchRun, RouterBenchRunRecord } from "@app/contracts";
import { scoreRouterCase, runRouterBench, type RouterBenchAdapters } from "./router-bench";
import { DECISION_GATE_FLOORS } from "./decision-bench";
import {
  loadRouterBenchRuns,
  loadRouterBenchSeal,
  routerBenchPromptsPin,
  routerBenchSamplesPin,
  writeRouterBenchRun,
} from "./router-bench-store";
import { renderRouterBenchReport } from "./router-bench-report";

const CASES_PATH = fileURLToPath(
  new URL("../../../benchmarks/routing/samples/cases.json", import.meta.url),
);
const SEAL_PATH = fileURLToPath(
  new URL("../../../benchmarks/routing/samples/version.json", import.meta.url),
);

const COST = {
  modelId: "fake/model",
  tokensIn: 100,
  tokensOut: 10,
  latencyMs: 50,
  costMicroUsd: 5,
};

const replyOf = (overrides: Record<string, unknown>) =>
  JSON.stringify({ intent: "ruling", category: "theme-a", ...overrides });

/** A self-consistent run for one arm, overridable per test. */
const runOf = (model: string, over: Partial<RouterBenchRun> = {}): RouterBenchRun => ({
  schema: 1,
  task: "router-bench",
  model,
  samples: { version: 1, casesSha256: "sha256:e06d9a04" },
  promptsSha256: "sha256:abc123",
  budget: { capMicroUsd: null, plannedCases: 2, totalMicroUsd: 10 },
  totals: { cases: 2, scored: 2, passed: 1, accuracy: 0.5 },
  gate: {
    gatePass: false,
    overallAccuracy: 0.5,
    failedLanguages: ["id"],
    floors: { overall: 0.85, perLanguage: 0.75, minCasesPerLanguage: 3 },
  },
  startedAt: "2026-11-14T00:00:00.000Z",
  finishedAt: "2026-11-14T00:00:01.000Z",
  records: [
    {
      caseId: "rt-id-01",
      language: "id",
      expected: '{"intent":"ruling"}',
      got: '{"intent":"ruling"}',
      passed: true,
      cost: COST,
    },
    {
      caseId: "rt-en-01",
      language: "en",
      expected: '{"intent":"ruling"}',
      got: '{"intent":"factual"}',
      passed: false,
    },
  ],
  ...over,
});

describe("router-bench scoring", () => {
  const adapters: RouterBenchAdapters = {
    buildCall: () => ({ turns: [] }),
    readReply: () => undefined,
  };

  it("a case passes when every asserted field matches the reply", () => {
    expect(scoreRouterCase({ intent: "ruling" }, { intent: "ruling" })).toBe(true);
    expect(
      scoreRouterCase(
        { intent: "ruling", category: "theme-a" },
        { intent: "ruling", category: "theme-a" },
      ),
    ).toBe(true);
  });

  it("an unreadable reply is a miss, never a guessed pass", () => {
    expect(scoreRouterCase({ intent: "ruling" }, undefined)).toBe(false);
  });

  it("unasserted fields are free; asserted ones must match exactly", () => {
    // category unasserted: any value is fine
    expect(scoreRouterCase({ intent: "ruling" }, { intent: "ruling", category: "theme-a" })).toBe(
      true,
    );
    // category asserted: it must match exactly
    expect(
      scoreRouterCase(
        { intent: "ruling", category: "theme-a" },
        { intent: "ruling", category: "theme-a" },
      ),
    ).toBe(true);
    expect(
      scoreRouterCase(
        { intent: "ruling", category: "theme-a" },
        { intent: "ruling", category: "theme-b" },
      ),
    ).toBe(false);
  });

  it("the engine runs the loop through the adapters, surfacing cost per case", async () => {
    const fixture: RouterBenchFixture = {
      id: "f",
      status: "v0-draft",
      cases: [
        { id: "c1", language: "id", question: "q1", expected: { intent: "ruling" } },
        { id: "c2", language: "en", question: "q2", expected: { intent: "factual" } },
      ],
    };
    const seen: string[] = [];
    const outcomes = await runRouterBench({
      provider: {
        generate: (spec: { turns: readonly unknown[] }) => {
          seen.push((spec.turns as { content: string }[]).at(-1)!.content);
          return Effect.succeed({ text: replyOf({ intent: "ruling" }), cost: COST });
        },
      } as never,
      fixture,
      adapters: {
        buildCall: (c) => ({ turns: [{ role: "user", content: c.question }] }),
        readReply: (text) => JSON.parse(text) as ReturnType<RouterBenchAdapters["readReply"]>,
      },
      onCost: () => {},
      wouldExceed: () => false,
    });
    expect(seen).toEqual(["q1", "q2"]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.passed).toBe(true);
    expect(outcomes[0]?.cost).toEqual(COST);
    expect(outcomes[1]?.passed).toBe(false);
    expect(outcomes[1]?.got).toContain('"intent":"ruling"');
  });
});

describe("router-bench store — the committed seal", () => {
  const fixture = JSON.parse(readFileSync(CASES_PATH, "utf8")) as Parameters<
    typeof loadRouterBenchSeal
  >[2];

  it("the committed seal verifies against the committed case bytes", () => {
    const seal = loadRouterBenchSeal(SEAL_PATH, CASES_PATH, fixture);
    expect(seal.version).toBe(2);
    expect(seal.task).toBe("router-bench");
    expect(seal.counts.cases).toBe(fixture.cases.length);
  });

  it("cases bytes that no longer match the seal fail before any spend", () => {
    const dir = mkdtempSync(join(tmpdir(), "router-bench-seal-"));
    try {
      const tampered = join(dir, "cases.json");
      writeFileSync(tampered, readFileSync(CASES_PATH, "utf8").replace("v0-draft", "v0-draf"));
      expect(() => loadRouterBenchSeal(SEAL_PATH, tampered, fixture)).toThrow(
        /cases hash mismatch.*re-seal before running/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("router-bench store — run files", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "router-bench-runs-"));
    mkdirSync(join(dir, "runs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const runsDir = () => join(dir, "runs");
  const seal = {
    task: "router-bench",
    version: 1,
    created: "2026-11-13T23:40:28Z",
    fixture: { id: "router-bench-v0", status: "v0-draft" },
    counts: { cases: 25 },
    languages: { ar: 8, en: 8, id: 9 },
    hashes: { cases: "sha256:e06d9a04" },
  };

  it("writes a run once, refuses an overwrite without force, replaces with it", () => {
    writeRouterBenchRun(runsDir(), runOf("a/one"));
    expect(readFileSync(join(runsDir(), "a-one.json"), "utf8")).toMatch(/"a\/one"/);
    expect(() => writeRouterBenchRun(runsDir(), runOf("a/one"))).toThrow(/already exists.*--force/);
    writeRouterBenchRun(runsDir(), runOf("a/one", { promptsSha256: "sha256:re-run" }), {
      force: true,
    });
    expect(readFileSync(join(runsDir(), "a-one.json"), "utf8")).toContain("re-run");
  });

  it("loads committed runs in file-name order and refuses a stale samples pin", () => {
    writeRouterBenchRun(runsDir(), runOf("b/two"));
    writeRouterBenchRun(runsDir(), runOf("a/one"));
    const runs = loadRouterBenchRuns(runsDir(), seal);
    expect(runs.map((r) => r.model)).toEqual(["a/one", "b/two"]);
    writeRouterBenchRun(
      runsDir(),
      runOf("c/stale", { samples: { version: 2, casesSha256: "sha256:different-bytes" } }),
      { force: true },
    );
    expect(() => loadRouterBenchRuns(runsDir(), seal)).toThrow(
      /pins samples v2.*archive it under superseded/,
    );
  });

  it("refuses a run whose totals disagree with its own records", () => {
    // The load path parses every file — a drifted summary surfaces there.
    const drifted = runOf("a/one", { totals: { cases: 2, scored: 2, passed: 2, accuracy: 1 } });
    writeRouterBenchRun(runsDir(), drifted, { force: true });
    expect(() => loadRouterBenchRuns(runsDir(), seal)).toThrow(
      /totals\.passed 2 does not match the 1 passing/,
    );
  });

  it("the samples pin and prompts pin are deterministic", () => {
    expect(routerBenchSamplesPin(seal)).toEqual({ version: 1, casesSha256: "sha256:e06d9a04" });
    expect(routerBenchPromptsPin("wording")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(routerBenchPromptsPin("wording")).toBe(routerBenchPromptsPin("wording"));
  });
});

describe("router-bench report", () => {
  const render = (runs: RouterBenchRun[], supersededCount = 0) =>
    renderRouterBenchReport({
      seal: {
        task: "router-bench",
        version: 1,
        created: "2026-11-13T23:40:28Z",
        fixture: { id: "router-bench-v0", status: "v0-draft" },
        counts: { cases: 25 },
        languages: { ar: 8, en: 8, id: 9 },
        hashes: { cases: "sha256:e06d9a04" },
        notes: ["The seal covers the case fixture only."],
      },
      runs,
      runsDir: "benchmarks/routing/runs",
      generatedAt: "2026-11-14T00:00:02.000Z",
      supersededCount,
    });

  it("an empty store renders the unmeasured state, honestly", () => {
    const md = render([]);
    expect(md).toContain("# Router benchmark report");
    expect(md).toContain("never hand-edited");
    expect(md).toContain(`overall ≥ ${DECISION_GATE_FLOORS.overall}`);
    expect(md).toContain("No runs at the committed seal yet");
    expect(md).toContain("No arm passes the gate at this seal.");
    expect(md).not.toContain("## Superseded");
  });

  it("arms are derived from records and the selection lists only passing arms", () => {
    const md = render([runOf("a/winner")]);
    expect(md).toContain("| `a/winner` |");
    expect(md).toContain("`benchmarks/routing/runs/a-winner.json`");
    expect(md).toContain("| 50.0% |");
    expect(md).toContain("**fail** |");
    expect(md).toContain("recomputed from each run's records");
    expect(md).toContain("- `a/winner` (1):");
    expect(md).toContain("`rt-en-01` (en)");
    expect(md).toContain("No arm passes the gate at this seal.");
  });

  it("an aborted run is evidence, never a pass", () => {
    const aborted = {
      ...runOf("c/dead"),
      aborted: true,
      error: "vendor 500 on rt-id-01",
    };
    const md = render([aborted]);
    expect(md).toContain("⚠ aborted (vendor 500 on rt-id-01)");
    expect(md).toContain("No arm passes the gate at this seal.");
  });

  it("the superseded history line renders when the archive is non-empty", () => {
    expect(render([], 2)).toContain("## Superseded");
  });
});
