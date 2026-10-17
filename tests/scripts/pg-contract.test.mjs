import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import {
  GATE_FILES,
  MARKER,
  MIN_GATED_SUITES,
  PgContractError,
  assertExecuted,
  assertMarked,
  contractRelevant,
  declaredSuiteFiles,
  readReport,
} from "../../scripts/pg-contract/policy.mjs";

/**
 * The contract gate's own gate.
 *
 * A `DATABASE_URL`-gated suite is collected by the DB-less run, reported green,
 * and executed by nothing unless the `postgres:contract` job selects it. Every
 * assertion below is about that absence of a run being observable: the
 * derivation is exercised on the live tree, and the policy is driven over
 * fixture reports of the shapes a real run produces, so a policy that stopped
 * reddening cannot pass here.
 */

const DRIVER = "scripts/pg-contract.mjs";
/** The store-seam contract suite: the suite the derivation must find. */
const CONTRACT_SUITE = "packages/infra/src/rag-store-postgres.test.ts";

const read = (rel) => readFileSync(resolve(process.cwd(), rel), "utf8");

const runDriver = (...args) =>
  spawnSync(process.execPath, [DRIVER, ...args], { cwd: process.cwd(), encoding: "utf8" });

/** A vitest JSON report entry for one file, from the statuses its tests reached. */
const entry = (root, file, statuses) => ({
  name: resolve(root, file),
  status: statuses.includes("failed") ? "failed" : "passed",
  assertionResults: statuses.map((status) => ({ status })),
});

const report = (root, entries) => ({ numTotalTests: entries.length, testResults: entries });

/** A throwaway tree, so the derivation is driven over known files. */
function fixtureTree(files) {
  const root = mkdtempSync(join(tmpdir(), "kajianq-pg-contract-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("the gated suites are derived from the tree, not listed", () => {
  it("finds the store-seam contract suite by its marker", () => {
    const declared = declaredSuiteFiles(process.cwd());
    expect(declared.length).toBeGreaterThanOrEqual(MIN_GATED_SUITES);
    expect(declared).toContain(CONTRACT_SUITE);
    expect(read(CONTRACT_SUITE)).toMatch(new RegExp(`^\\s*//\\s*${MARKER}\\b`, "m"));
  });

  it("prints that derivation from the driver, so the workflow has one source of truth", () => {
    const listed = runDriver("--list");
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout.split("\n").filter(Boolean)).toEqual(declaredSuiteFiles(process.cwd()));
    expect(listed.stdout).toContain(CONTRACT_SUITE);
  });

  it("refuses to select nothing, rather than running nothing and passing", () => {
    const fixture = fixtureTree({ "packages/infra/src/plain.test.ts": "describe('x', () => {});" });
    try {
      expect(() => declaredSuiteFiles(fixture.root)).toThrow(PgContractError);
      expect(() => declaredSuiteFiles(fixture.root)).toThrow(/no gated suite found/);
    } finally {
      fixture.cleanup();
    }
  });

  it("declares a file by a line comment, not by prose that quotes the marker", () => {
    const fixture = fixtureTree({
      "tests/scripts/quoted.test.mjs": `/**\n * ${MARKER} is declared with a line comment.\n */\n`,
      "tests/scripts/declared.test.mjs": `// ${MARKER}\ndescribe("x", () => {});\n`,
    });
    try {
      expect(declaredSuiteFiles(fixture.root)).toEqual(["tests/scripts/declared.test.mjs"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("reads a report, and names what is missing when it cannot", () => {
    const root = process.cwd();
    const fixture = fixtureTree({
      "report.json": JSON.stringify(report(root, [entry(root, CONTRACT_SUITE, ["passed"])])),
      "not-a-report.json": JSON.stringify({ success: true }),
    });
    try {
      expect(readReport(join(fixture.root, "report.json")).numTotalTests).toBe(1);
      expect(() => readReport(join(fixture.root, "absent.json"))).toThrow(/no test report/);
      expect(() => readReport(join(fixture.root, "not-a-report.json"))).toThrow(
        /not a vitest JSON report/,
      );
    } finally {
      fixture.cleanup();
    }
  });
});

describe("a DB-less run may only skip suites some job runs", () => {
  const root = process.cwd();
  const declared = [CONTRACT_SUITE];
  const gated = entry(root, CONTRACT_SUITE, ["skipped", "skipped"]);

  it("passes when the only suite skipped in full is the declared one", () => {
    expect(assertMarked(report(root, [gated]), declared, root)).toEqual(declared);
  });

  it("names the suite skipped in full that no job runs, and says what to add", () => {
    const undeclared = entry(root, "apps/api/src/new-gated.test.ts", ["skipped"]);
    expect(() => assertMarked(report(root, [gated, undeclared]), declared, root)).toThrow(
      /apps\/api\/src\/new-gated\.test\.ts/,
    );
    expect(() => assertMarked(report(root, [gated, undeclared]), declared, root)).toThrow(
      new RegExp(`without declaring "${MARKER}"`),
    );
  });

  it("reads a partially-skipped file as one that executed, so the check is not a blanket skip-warning", () => {
    const partial = entry(root, "apps/api/src/partial.test.ts", ["passed", "skipped"]);
    expect(() => assertMarked(report(root, [gated, partial]), declared, root)).not.toThrow();
  });

  it("refuses a report with nothing in it, instead of passing vacuously", () => {
    expect(() => assertMarked(report(root, []), declared, root)).toThrow(/pass vacuously/);
  });

  it("refuses a report that shows no skip at all — that is not the DB-less run", () => {
    const ran = entry(root, CONTRACT_SUITE, ["passed"]);
    expect(() => assertMarked(report(root, [ran]), declared, root)).toThrow(/DB-less run/);
  });

  it("refuses a declared suite that skipped nothing — the marker would claim a gate that is not there", () => {
    const ran = entry(root, CONTRACT_SUITE, ["passed"]);
    const partial = entry(root, "apps/api/src/partial.test.ts", ["passed", "skipped"]);
    expect(() => assertMarked(report(root, [ran, partial]), declared, root)).toThrow(
      /but skipped nothing in this DB-less run/,
    );
  });
});

describe("a selected suite that executed nothing reddens the contract run", () => {
  const root = process.cwd();
  const declared = [CONTRACT_SUITE];

  it("passes a report in which every declared suite ran", () => {
    const ran = entry(root, CONTRACT_SUITE, ["passed", "passed"]);
    expect(assertExecuted(report(root, [ran]), declared, root)).toEqual(declared);
  });

  it("names a declared suite whose tests were all skipped — the run selected it and executed nothing", () => {
    const skipped = entry(root, CONTRACT_SUITE, ["skipped", "skipped", "skipped"]);
    expect(() => assertExecuted(report(root, [skipped]), declared, root)).toThrow(
      /executed none of its tests \(3 skipped\)/,
    );
  });

  it("names a declared suite the run never collected", () => {
    const other = entry(root, "apps/api/src/other.test.ts", ["passed"]);
    expect(() => assertExecuted(report(root, [other]), declared, root)).toThrow(
      /not collected by the run/,
    );
  });

  it("names a declared suite that skipped part of itself, since a gated suite runs entirely", () => {
    const partial = entry(root, CONTRACT_SUITE, ["passed", "skipped"]);
    expect(() => assertExecuted(report(root, [partial]), declared, root)).toThrow(
      /1 of its tests were skipped/,
    );
  });

  it("refuses an empty report, so an extraction that found nothing cannot pass", () => {
    expect(() => assertExecuted(report(root, []), declared, root)).toThrow(/pass vacuously/);
  });
});

describe("the contract job engages on what can change what it executes", () => {
  const declared = [CONTRACT_SUITE];

  it("engages on the seam, on a declared suite, and on the gate's own files", () => {
    expect(
      contractRelevant(["packages/infra/src/rag-store-postgres-similarity.ts"], declared),
    ).toBe(true);
    expect(contractRelevant([CONTRACT_SUITE], declared)).toBe(true);
    for (const file of GATE_FILES) expect(contractRelevant([file], declared)).toBe(true);
  });

  it("stays off for a change that cannot alter what the suites execute", () => {
    expect(contractRelevant(["docs/VPS-SETUP.md", "apps/web/src/lib/theme.ts"], declared)).toBe(
      false,
    );
    expect(contractRelevant([], declared)).toBe(false);
  });

  it("reports the decision through the driver, and fails closed on a missing list", () => {
    const fixture = fixtureTree({
      "unrelated.txt": "docs/VPS-SETUP.md\n",
      "relevant.txt": `${CONTRACT_SUITE}\n`,
      "empty.txt": "\n",
    });
    try {
      const decide = (name) => runDriver("--touched", join(fixture.root, name));
      expect(decide("unrelated.txt").stdout).toBe("touched=false\n");
      expect(decide("relevant.txt").stdout).toBe("touched=true\n");
      expect(decide("empty.txt").stdout).toBe("touched=false\n");
      const missing = decide("absent.txt");
      expect(missing.status).toBe(2);
      expect(missing.stderr).toMatch(/refusing to decide whether the contract job runs/);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("the workflow wires the mechanism, not a path list", () => {
  const ci = read(".github/workflows/ci.yml");

  it("runs what the derivation selects, then asserts each selected suite executed", () => {
    expect(ci).toMatch(/bunx vp test run[^\n]*\$\(bun scripts\/pg-contract\.mjs --list\)/);
    expect(ci).toMatch(/bun scripts\/pg-contract\.mjs --require-executed/);
  });

  it("asserts in the DB-less job that every suite it skipped is one the contract job runs", () => {
    expect(ci).toMatch(/bun run test --reporter=default --reporter=json/);
    expect(ci).toMatch(/bun scripts\/pg-contract\.mjs --require-marked/);
  });

  it("leaves no hardcoded contract path in a runner line", () => {
    expect(ci).not.toMatch(/^\s*run: bunx vp test run .*\.test\.ts/m);
  });

  it("names gate files that exist, so a rename cannot quietly drop one from the trigger", () => {
    for (const file of GATE_FILES) {
      expect(existsSync(resolve(process.cwd(), file)), file).toBe(true);
    }
  });
});
