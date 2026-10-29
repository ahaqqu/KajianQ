import { describe, expect, it } from "vite-plus/test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIngestionReport } from "@app/contracts";
import { hashFile, toCsv } from "./sanadset-csv";
import { runSanadsetStudy, studyRunId, type StudyOptions } from "./sanadset-study";
import { sampleSeed } from "./sanadset-sample";
import { resolveArm, type ApiKeyLookup } from "./sanadset-arm";
import { TEST_ARM_CONFIG } from "./test-utils/sanadset-arm";
import type { FetchLike } from "./sanadset-model";
import {
  LABELS_CSV,
  PREDICTIONS_JSON,
  QUARANTINE_JSON,
  REPORT_JSON,
  REPORT_MARKDOWN,
  SAMPLE_JSON,
  SPOT_CHECK_CSV,
} from "./sanadset-artifacts";

/**
 * Test intent, named before the assertions:
 * - trap: the sample must exist on disk *before* the first model request. The stub
 *   transport reads the artifact directory from inside the request, so a reordering of
 *   the run fails the test instead of passing silently;
 * - trap: a re-run on the same bytes must reproduce every count and both derived rates.
 *   Only timings and the preregistration's clock may differ, or "pre-registered" is
 *   unverifiable;
 * - trap: `--limit` must be visible in the report, so a rehearsal's counts can never be
 *   read as a full-file census.
 */

const BUKHARI = "صحيح البخاري";
const MUSLIM = "صحيح مسلم";
const HEADER = ["Hadith", "Book", "Num_hadith", "Matn", "Sanad", "Sanad_Length"];

function chain(...names: string[]): string {
  return `[${names.map((name) => `'${name}'`).join(", ")}]`;
}

function fixtureRows(): string[][] {
  const rows: string[][] = [HEADER];
  const add = (book: string, number: string, matn: string, sanad: string, length: string): void => {
    rows.push([`<SANAD>…</SANAD> <MATN>${matn}</MATN>`, book, number, matn, sanad, length]);
  };
  add(BUKHARI, "1", "إنما الأعمال بالنيات", chain("مالك بن أنس", "نافع", "عبد الله بن عمر"), "3");
  add(BUKHARI, "2", "إنما الأعمال بالنيات", chain("الليث", "نافع", "عبد الله بن عمر"), "3");
  add(MUSLIM, "1", "الدين النصيحة", chain("سفيان", "علقمة"), "2");
  add(BUKHARI, "3", "لا إله إلا الله", "No SANAD", "0");
  add(
    BUKHARI,
    "4",
    "من حسن إسلام المرء",
    chain(...Array.from({ length: 31 }, (_, index) => `راوي ${index}`)),
    "31",
  );
  add(MUSLIM, "2", "مثله", chain("شعبة", "منصور"), "2");
  add(BUKHARI, "5", "إِنَّمَا الأَعْمَالُ بِالنِّيَّاتِ", chain("سعيد", "نافع", "عبد الله بن عمر"), "3");
  add(MUSLIM, "3", "من يرد الله به خيرا", chain("مالك", "نافع"), "2");
  rows.push([
    `<SANAD>a</SANAD> <MATN>first <SANAD>b</SANAD> <MATN>second</MATN>`,
    BUKHARI,
    "6",
    "نص",
    chain("مالك", "نافع"),
    "2",
  ]);
  add(MUSLIM, "4", "الطهور شطر الإيمان", chain("أبو هريرة"), "1");
  return rows;
}

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sanadset-study-"));
  const path = join(dir, "slice.csv");
  writeFileSync(path, toCsv(fixtureRows()), "utf8");
  return path;
}

const PRESENT: ApiKeyLookup = {
  key: { value: "test-key-not-a-real-secret", source: "env" },
  detail: "TEST key set",
};
const ABSENT: ApiKeyLookup = { key: null, detail: "no key" };

function options(
  input: { csvPath: string; sha256: string; outDir: string } & Partial<StudyOptions>,
): StudyOptions {
  const { csvPath, sha256, outDir, ...rest } = input;
  return {
    csvPath,
    outDir,
    command: "bun study:sanadset --test",
    expectedSha256: sha256,
    ceiling: 100,
    capMicroUsd: 50_000_000,
    arm: {
      requested: false,
      definition: resolveArm({ provider: "dashscope" }, TEST_ARM_CONFIG),
      lookup: ABSENT,
    },
    now: () => 1_700_000_000_000,
    ...rest,
  };
}

function verdictStub(): { fetch: FetchLike; calls: number[] } {
  const calls: number[] = [];
  const fetch: FetchLike = async () => {
    calls.push(Date.now());
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: '{"verdict":"same"}' } }],
          usage: { prompt_tokens: 40, completion_tokens: 4 },
        }),
    };
  };
  return { fetch, calls };
}

describe("a full study run", () => {
  it("writes the artifact set in the order the invariants require", async () => {
    const fixture = makeFixture();
    const hashed = await hashFile(fixture);
    const dir = mkdtempSync(join(tmpdir(), "sanadset-out-"));
    const run = await runSanadsetStudy(
      options({ csvPath: fixture, sha256: hashed.sha256, outDir: dir }),
    );

    const names = run.written.map((path) => path.split("/").pop());
    expect(names.slice(0, 3)).toEqual([SAMPLE_JSON, LABELS_CSV, SPOT_CHECK_CSV]);
    for (const name of [REPORT_JSON, REPORT_MARKDOWN, QUARANTINE_JSON])
      expect(names).toContain(name);
    for (const name of [
      SAMPLE_JSON,
      LABELS_CSV,
      SPOT_CHECK_CSV,
      REPORT_JSON,
      REPORT_MARKDOWN,
      QUARANTINE_JSON,
    ]) {
      expect(existsSync(join(run.artifactsDir, name))).toBe(true);
    }
    expect(existsSync(join(run.artifactsDir, PREDICTIONS_JSON))).toBe(false);
    expect(run.document.study.modelArm.stopReason).toBe("not-requested");
  });

  it("scopes every artifact to a directory named by the run id, outside the repo", async () => {
    const fixture = makeFixture();
    const hashed = await hashFile(fixture);
    const dir = mkdtempSync(join(tmpdir(), "sanadset-out-"));
    const run = await runSanadsetStudy(
      options({ csvPath: fixture, sha256: hashed.sha256, outDir: dir }),
    );
    expect(run.artifactsDir).toBe(join(dir, run.runId));
    expect(run.written.every((path) => path.startsWith(`${run.artifactsDir}/`))).toBe(true);
    expect(run.document.study.artifactsDir).toBe(run.artifactsDir);
    expect(readFileSync(join(run.artifactsDir, REPORT_MARKDOWN), "utf8")).toContain(run.runId);
    expect(existsSync(join(dir, SAMPLE_JSON))).toBe(false);
  });

  it("refuses to overwrite a label sheet the owner has already scored", async () => {
    const fixture = makeFixture();
    const hashed = await hashFile(fixture);
    const dir = mkdtempSync(join(tmpdir(), "sanadset-out-"));
    const first = await runSanadsetStudy(
      options({ csvPath: fixture, sha256: hashed.sha256, outDir: dir }),
    );
    // The owner scores a row: the evidence this study exists to produce is now on disk.
    const labelsPath = join(first.artifactsDir, LABELS_CSV);
    const rows = toCsv([
      ["pair_id", "kind", "a", "b", "label", "notes"],
      ["P001", "matn", "a", "b", "same", "owner-scored"],
    ]);
    writeFileSync(labelsPath, rows, "utf8");
    const before = readFileSync(labelsPath, "utf8");

    await expect(
      runSanadsetStudy(options({ csvPath: fixture, sha256: hashed.sha256, outDir: dir })),
    ).rejects.toThrow(/scored labels/u);
    expect(readFileSync(labelsPath, "utf8")).toBe(before);
  });

  it("records the measured counts the report quotes", async () => {
    const fixture = makeFixture();
    const hashed = await hashFile(fixture);
    const dir = mkdtempSync(join(tmpdir(), "sanadset-out-"));
    const run = await runSanadsetStudy(
      options({ csvPath: fixture, sha256: hashed.sha256, outDir: dir }),
    );
    const facts = run.document.study;

    expect(facts.slice.rows).toBe(10);
    expect(facts.slice.noSanad).toBe(1);
    expect(facts.quarantine.total).toBeGreaterThan(0);
    expect(facts.quarantine.byRule["implausible_chain_length"]).toBe(1);
    expect(facts.quarantine.byRule["reference_only_matn"]).toBe(1);
    expect(facts.quarantine.byRule["nested_sanad_in_matn"]).toBe(1);
    expect(facts.slice.unbalancedTagRows).toBe(1);
    expect(facts.matn.children).toBeGreaterThan(0);
    expect(facts.matn.matchRate.scope).toBe("slice-internal");
    expect(facts.matn.distinctMatnTexts).toBeGreaterThanOrEqual(facts.matn.children);
    expect(facts.narrator.mentions).toBeGreaterThan(0);
    expect(facts.narrator.nonSingletonMentionRate).toBeGreaterThanOrEqual(0);
  });

  it("writes a report.json that satisfies the ingestion contract", async () => {
    const fixture = makeFixture();
    const hashed = await hashFile(fixture);
    const dir = mkdtempSync(join(tmpdir(), "sanadset-out-"));
    const run = await runSanadsetStudy(
      options({ csvPath: fixture, sha256: hashed.sha256, outDir: dir }),
    );
    const parsed = parseIngestionReport(
      JSON.parse(readFileSync(join(run.artifactsDir, REPORT_JSON), "utf8")).report,
    );
    expect(parsed.parentsWritten).toBe(0);
    expect(parsed.childrenWritten).toBe(0);
    expect(parsed.llmCalls).toEqual([]);
    expect(readFileSync(join(run.artifactsDir, QUARANTINE_JSON), "utf8")).toContain(
      "implausible_chain_length",
    );
  });

  it("pre-registers the sample before the first model request", async () => {
    const fixture = makeFixture();
    const hashed = await hashFile(fixture);
    const dir = mkdtempSync(join(tmpdir(), "sanadset-out-"));
    const runId = studyRunId({ sha256: hashed.sha256, seed: sampleSeed(hashed.sha256) });
    let sampleExistedAtFirstCall = false;
    const stub = verdictStub();
    const fetch: FetchLike = async (url, init) => {
      if (!sampleExistedAtFirstCall)
        sampleExistedAtFirstCall = existsSync(join(dir, runId, SAMPLE_JSON));
      return stub.fetch(url, init);
    };
    const run = await runSanadsetStudy(
      options({
        csvPath: fixture,
        sha256: hashed.sha256,
        outDir: dir,
        arm: {
          requested: true,
          definition: resolveArm({ provider: "dashscope" }, TEST_ARM_CONFIG),
          lookup: PRESENT,
        },
        fetch,
      }),
    );
    expect(stub.calls.length).toBeGreaterThan(0);
    expect(sampleExistedAtFirstCall).toBe(true);
    expect(run.document.study.modelArm.ran).toBe(true);
    expect(run.document.study.modelArm.calls).toBeGreaterThan(0);
    expect(run.document.study.modelArm.spendMicroUsd).toBeGreaterThan(0);
    expect(existsSync(join(run.artifactsDir, PREDICTIONS_JSON))).toBe(true);
    const predictions = JSON.parse(readFileSync(join(run.artifactsDir, PREDICTIONS_JSON), "utf8"));
    expect(predictions.model).toBe("qwen-test");
    expect(predictions.predictions.length).toBe(run.document.study.sample.selected);
    expect(JSON.stringify(predictions)).not.toContain("test-key-not-a-real-secret");
  });

  it("reports an absent key instead of failing, and spends nothing", async () => {
    const fixture = makeFixture();
    const hashed = await hashFile(fixture);
    const dir = mkdtempSync(join(tmpdir(), "sanadset-out-"));
    const run = await runSanadsetStudy(
      options({
        csvPath: fixture,
        sha256: hashed.sha256,
        outDir: dir,
        arm: {
          requested: true,
          definition: resolveArm({ provider: "dashscope" }, TEST_ARM_CONFIG),
          lookup: ABSENT,
        },
      }),
    );
    expect(run.document.study.modelArm.stopReason).toBe("key-absent");
    expect(run.document.study.modelArm.spendMicroUsd).toBe(0);
    expect(run.document.study.modelArm.requests).toBe(0);
    expect(run.predictions).toEqual([]);
  });

  it("is idempotent: a second run on the same bytes reproduces every count and the markdown", async () => {
    const fixture = makeFixture();
    const hashed = await hashFile(fixture);
    const firstDir = mkdtempSync(join(tmpdir(), "sanadset-a-"));
    const secondDir = mkdtempSync(join(tmpdir(), "sanadset-b-"));
    const first = await runSanadsetStudy(
      options({ csvPath: fixture, sha256: hashed.sha256, outDir: firstDir, now: () => 1_000 }),
    );
    const second = await runSanadsetStudy(
      options({ csvPath: fixture, sha256: hashed.sha256, outDir: secondDir, now: () => 9_000 }),
    );
    expect(second.runId).toBe(first.runId);
    // The artifact directory is a run parameter, not a measured fact: the two runs write
    // different directories and must agree on everything the directory does not change.
    expect({ ...second.document.study, timings: null, artifactsDir: null }).toEqual({
      ...first.document.study,
      timings: null,
      artifactsDir: null,
    });
    const withoutArtifactDir = (dir: string): string =>
      readFileSync(join(dir, REPORT_MARKDOWN), "utf8")
        .split("\n")
        .filter((line) => !line.startsWith("- Directory:"))
        .join("\n");
    expect(withoutArtifactDir(second.artifactsDir)).toEqual(withoutArtifactDir(first.artifactsDir));
    const sample = (dir: string): string =>
      JSON.stringify(
        (JSON.parse(readFileSync(join(dir, SAMPLE_JSON), "utf8")) as { pairs: unknown }).pairs,
      );
    expect(sample(second.artifactsDir)).toEqual(sample(first.artifactsDir));
  });

  it("reconciles the sample and band calls into the projected total", async () => {
    const fixture = makeFixture();
    const hashed = await hashFile(fixture);
    const dir = mkdtempSync(join(tmpdir(), "sanadset-out-"));
    const run = await runSanadsetStudy(
      options({ csvPath: fixture, sha256: hashed.sha256, outDir: dir }),
    );
    const facts = run.document.study;
    expect(facts.band.sampleCalls).toBe(facts.sample.selected);
    expect(facts.band.callsNeeded).toBe(facts.band.sampleCalls + facts.band.matnRows);
    expect(facts.band.callsBudgeted).toBe(Math.min(facts.band.ceiling, facts.band.callsNeeded));
    expect(facts.modelArm.estimate?.calls).toBe(
      Math.min(facts.band.ceiling, facts.band.callsNeeded),
    );
    expect(facts.band.matnBandLower).toBe(0.6);
    expect(facts.band.matnBandUpper).toBe(0.9);
  });

  it("draws no pair whose two sides are the same string", async () => {
    const fixture = makeFixture();
    const hashed = await hashFile(fixture);
    const dir = mkdtempSync(join(tmpdir(), "sanadset-out-"));
    const run = await runSanadsetStudy(
      options({ csvPath: fixture, sha256: hashed.sha256, outDir: dir }),
    );
    const artifact = JSON.parse(readFileSync(join(run.artifactsDir, SAMPLE_JSON), "utf8")) as {
      pairs: { a: string; b: string; stratum: string }[];
    };
    expect(artifact.pairs.length).toBeGreaterThan(0);
    expect(artifact.pairs.every((pair) => pair.a !== pair.b)).toBe(true);
  });

  it("makes no cross-book matn join and states the book scope", async () => {
    const fixture = makeFixture();
    const hashed = await hashFile(fixture);
    const dir = mkdtempSync(join(tmpdir(), "sanadset-out-"));
    const run = await runSanadsetStudy(
      options({ csvPath: fixture, sha256: hashed.sha256, outDir: dir }),
    );
    const facts = run.document.study;
    expect(facts.matn.bookScope).toBe("book");
    expect(facts.matn.crossBook.joinsInThisRun).toBe(0);
    expect(facts.matn.crossBook.scopedChildren).toBe(facts.matn.children);
  });

  it("records a bounded rehearsal as bounded", async () => {
    const fixture = makeFixture();
    const hashed = await hashFile(fixture);
    const dir = mkdtempSync(join(tmpdir(), "sanadset-out-"));
    const run = await runSanadsetStudy(
      options({ csvPath: fixture, sha256: hashed.sha256, outDir: dir, limit: 4 }),
    );
    expect(run.document.study.source.recordsRead).toBe(4);
    expect(run.runId).toContain("-limit4");
    expect(run.document.study.limits.some((limit) => limit.includes("--limit 4"))).toBe(true);
  });

  it("refuses bytes that do not match the pinned digest", async () => {
    const fixture = makeFixture();
    await expect(
      runSanadsetStudy(
        options({
          csvPath: fixture,
          sha256: "0".repeat(64),
          outDir: mkdtempSync(join(tmpdir(), "c-")),
        }),
      ),
    ).rejects.toThrow(/does not match the pinned/u);
  });
});
