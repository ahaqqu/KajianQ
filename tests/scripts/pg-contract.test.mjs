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
  TEST_FILE_RE,
  TEST_ROOTS,
  assertExecuted,
  assertMarked,
  classify,
  contractRelevant,
  declaredSuiteFiles,
  readReport,
  undeclaredGates,
} from "../../scripts/pg-contract/policy.mjs";

/**
 * The contract gate's own gate.
 *
 * A `DATABASE_URL`-gated suite is collected by the DB-less run, reported green,
 * and executed by nothing unless the `postgres:contract` job selects it. Every
 * assertion below is about that absence of a run being observable: the
 * derivation is exercised on the live tree, the policy is driven over fixture
 * reports and fixture trees of the shapes a real run produces, and the walk is
 * pinned against the globs the runner actually collects.
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

/** A throwaway tree, so the derivation and the static gate are driven over known files. */
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

  it("declares every test file that reads DATABASE_URL from the environment", () => {
    // The static half, on the live tree: a suite that gates by returning early
    // from a test reports a pass and skips nothing, so the report cannot see it
    // and this is the check that does.
    expect(undeclaredGates(declaredSuiteFiles(process.cwd()), process.cwd())).toEqual([]);
  });

  it("walks every tree and file name vitest.config.ts collects", () => {
    // The roots and the name pattern are the runner's, restated once here: a
    // suite under a tree this walk never enters, or behind a name it drops, is
    // collected by `gate` and selected by nothing.
    const block = /include:\s*\[([\s\S]*?)\]/.exec(read("vitest.config.ts"))?.[1];
    expect(block, "vitest.config.ts: no test.include block").toBeTruthy();
    const globs = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(globs.length, "no include glob extracted — the pin would be vacuous").toBeGreaterThan(0);
    for (const glob of globs) {
      expect(TEST_ROOTS, `${glob}: the walk does not enter this tree`).toContain(
        glob.split("/")[0],
      );
      const name = glob.split("/").pop();
      const names = name.includes("{test,prop.test}")
        ? [name.replace("{test,prop.test}", "test"), name.replace("{test,prop.test}", "prop.test")]
        : [name];
      for (const sample of names) {
        expect(sample.replace(/^\*/, "suite"), `${glob}: the walk drops this name`).toMatch(
          TEST_FILE_RE,
        );
      }
    }
  });

  it("reads a report, and names what is missing when it cannot", () => {
    const root = process.cwd();
    const fixture = fixtureTree({
      "report.json": JSON.stringify(report(root, [entry(root, CONTRACT_SUITE, ["passed"])])),
      "not-a-report.json": JSON.stringify({ success: true }),
      "truncated.json": '{"numTotalTests": 3, "testResu',
    });
    try {
      expect(readReport(join(fixture.root, "report.json")).numTotalTests).toBe(1);
      expect(() => readReport(join(fixture.root, "absent.json"))).toThrow(/no test report/);
      expect(() => readReport(join(fixture.root, "not-a-report.json"))).toThrow(
        /not a vitest JSON report/,
      );
      // A report the runner was killed mid-write on: a thrown gate with a
      // message, never a raw SyntaxError stack out of the policy.
      expect(() => readReport(join(fixture.root, "truncated.json"))).toThrow(PgContractError);
      expect(() => readReport(join(fixture.root, "truncated.json"))).toThrow(
        /not parseable as JSON/,
      );
    } finally {
      fixture.cleanup();
    }
  });
});

describe("one report reads as one classification", () => {
  const root = process.cwd();
  const declared = [CONTRACT_SUITE];

  it("carries declared / collected / executed / skipped per suite, and the predicates built on them", () => {
    const ran = entry(root, CONTRACT_SUITE, ["passed", "passed"]);
    const partial = entry(root, "apps/api/src/partial.test.ts", ["passed", "skipped"]);
    const clean = entry(root, "apps/api/src/clean.test.ts", ["passed"]);
    const read = classify(report(root, [ran, partial, clean]), declared, root);
    expect(read.suites.find((suite) => suite.file === CONTRACT_SUITE)).toMatchObject({
      declared: true,
      collected: true,
      executed: 2,
      skipped: 0,
    });
    expect(read.skippedAny).toBe(true);
    expect(read.undeclaredSkips.map((suite) => suite.file)).toEqual([
      "apps/api/src/partial.test.ts",
    ]);
    expect(read.unexecuted).toEqual([]);
    expect(read.neverSkipped.map((suite) => suite.file)).toEqual([CONTRACT_SUITE]);
  });

  it("enters a declared suite the run never collected as one that executed nothing", () => {
    const clean = entry(root, "apps/api/src/clean.test.ts", ["passed"]);
    const read = classify(report(root, [clean]), declared, root);
    expect(read.suites.find((suite) => suite.file === CONTRACT_SUITE)).toMatchObject({
      collected: false,
      executed: 0,
      skipped: 0,
    });
    expect(read.unexecuted.map((suite) => suite.file)).toEqual([CONTRACT_SUITE]);
    expect(read.skippedAny).toBe(false);
  });

  it("refuses an empty report, so an extraction that found nothing cannot pass", () => {
    expect(() => classify(report(root, []), declared, root)).toThrow(/pass vacuously/);
  });
});

describe("a DB-less run may only skip suites some job runs", () => {
  /**
   * A fixture world: a tree holding the declared suites — each carrying the
   * marker, and reading the variable a gate exists for — plus the report over
   * that same root. The static half of the gate reads the tree and the report
   * half reads the paths, so a report and its tree have to agree on their root.
   */
  const gatedWorld = ({ declared = ["tests/scripts/gated.test.mjs"], files = {} } = {}) => {
    const tree = fixtureTree({
      ...Object.fromEntries(
        declared.map((file) => [file, `// ${MARKER}\nconst url = process.env.DATABASE_URL;\n`]),
      ),
      ...files,
    });
    return {
      root: tree.root,
      declared,
      entry: (file, statuses) => entry(tree.root, file, statuses),
      report: (...entries) => report(tree.root, entries),
      cleanup: tree.cleanup,
    };
  };
  const DECLARED = "tests/scripts/gated.test.mjs";

  it("passes when the only suite that skipped is the declared one", () => {
    const world = gatedWorld();
    try {
      const gated = world.entry(DECLARED, ["skipped", "skipped"]);
      expect(assertMarked(world.report(gated), world.declared, world.root)).toEqual(world.declared);
    } finally {
      world.cleanup();
    }
  });

  it("names a suite skipped in full that no job runs, and says what to add", () => {
    const world = gatedWorld();
    try {
      const gated = world.entry(DECLARED, ["skipped", "skipped"]);
      const undeclared = world.entry("apps/api/src/new-gated.test.ts", ["skipped"]);
      expect(() =>
        assertMarked(world.report(gated, undeclared), world.declared, world.root),
      ).toThrow(/apps\/api\/src\/new-gated\.test\.ts/);
      expect(() =>
        assertMarked(world.report(gated, undeclared), world.declared, world.root),
      ).toThrow(new RegExp(`without declaring "${MARKER}"`));
    } finally {
      world.cleanup();
    }
  });

  it("names a suite that skipped only PART of itself — a half-hidden suite is still hidden", () => {
    const world = gatedWorld();
    try {
      const gated = world.entry(DECLARED, ["skipped", "skipped"]);
      const partial = world.entry("apps/api/src/partly-gated.test.ts", ["passed", "skipped"]);
      expect(() => assertMarked(world.report(gated, partial), world.declared, world.root)).toThrow(
        /apps\/api\/src\/partly-gated\.test\.ts \(1 skipped\)/,
      );
    } finally {
      world.cleanup();
    }
  });

  it("names a test file that reads DATABASE_URL without declaring the marker, even when it skipped nothing", () => {
    // The early-return shape: the report is a clean run, and only the tree shows
    // the gate.
    const world = gatedWorld({
      files: { "tests/scripts/hidden.test.mjs": "const url = process.env.DATABASE_URL;\n" },
    });
    try {
      expect(undeclaredGates(world.declared, world.root)).toEqual([
        "tests/scripts/hidden.test.mjs",
      ]);
      const ran = world.entry(DECLARED, ["skipped"]);
      expect(() => assertMarked(world.report(ran), world.declared, world.root)).toThrow(
        /tests\/scripts\/hidden\.test\.mjs/,
      );
      expect(() => assertMarked(world.report(ran), world.declared, world.root)).toThrow(
        /returning early/,
      );
      // Declaring it settles the static half for that file.
      expect(
        undeclaredGates(world.declared.concat("tests/scripts/hidden.test.mjs"), world.root),
      ).toEqual([]);
    } finally {
      world.cleanup();
    }
  });

  it("reports both halves at once when a run hides suites in both ways", () => {
    const world = gatedWorld({
      files: { "apps/api/src/early-return.test.ts": "if (!process.env.DATABASE_URL) return;\n" },
    });
    try {
      const gated = world.entry(DECLARED, ["skipped"]);
      const partial = world.entry("apps/api/src/partly-gated.test.ts", ["passed", "skipped"]);
      const message = (() => {
        try {
          assertMarked(world.report(gated, partial), world.declared, world.root);
          return "";
        } catch (error) {
          return error.message;
        }
      })();
      expect(message).toMatch(/partly-gated\.test\.ts/);
      expect(message).toMatch(/early-return\.test\.ts/);
    } finally {
      world.cleanup();
    }
  });

  it("refuses a report with nothing in it, instead of passing vacuously", () => {
    const world = gatedWorld();
    try {
      expect(() => assertMarked(world.report(), world.declared, world.root)).toThrow(
        /pass vacuously/,
      );
    } finally {
      world.cleanup();
    }
  });

  it("refuses a report that shows no skip at all — that is not the DB-less run", () => {
    const world = gatedWorld();
    try {
      const ran = world.entry(DECLARED, ["passed"]);
      expect(() => assertMarked(world.report(ran), world.declared, world.root)).toThrow(
        /DB-less run/,
      );
    } finally {
      world.cleanup();
    }
  });

  it("refuses a declared suite that skipped nothing — the marker would claim a gate that is not there", () => {
    const world = gatedWorld({
      declared: ["tests/scripts/gated-a.test.mjs", "tests/scripts/gated-b.test.mjs"],
    });
    try {
      const gated = world.entry("tests/scripts/gated-a.test.mjs", ["skipped"]);
      const ran = world.entry("tests/scripts/gated-b.test.mjs", ["passed"]);
      expect(() => assertMarked(world.report(gated, ran), world.declared, world.root)).toThrow(
        /but skipped nothing in this DB-less run/,
      );
    } finally {
      world.cleanup();
    }
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

  it("matches a declared path git hands over verbatim, and not the same path quoted", () => {
    // `git diff -z` is what keeps a non-ASCII path unquoted; a quoted one matches
    // no declared suite, and the job would silently not engage.
    const accented = "tests/scripts/héllo.test.mjs";
    expect(contractRelevant([accented], [accented])).toBe(true);
    expect(contractRelevant(['"tests/scripts/h\\303\\251llo.test.mjs"'], [accented])).toBe(false);
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
      "nul.txt": `${CONTRACT_SUITE}\0docs/VPS-SETUP.md\0`,
      "empty.txt": "\n",
    });
    try {
      const decide = (name) => runDriver("--touched", join(fixture.root, name));
      expect(decide("unrelated.txt").stdout).toBe("touched=false\n");
      expect(decide("relevant.txt").stdout).toBe("touched=true\n");
      expect(decide("nul.txt").stdout).toBe("touched=true\n");
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

  it("captures the derived selection before the runner starts, then runs it", () => {
    // Captured under `set -e`, so a failing derivation aborts the step instead of
    // running the whole suite against the contract database.
    expect(ci).toMatch(/FILES="\$\(bun scripts\/pg-contract\.mjs --list\)"/);
    expect(ci).toMatch(/bunx vp test run[^\n]*\$FILES/);
    expect(ci).toMatch(/bun scripts\/pg-contract\.mjs --require-executed/);
  });

  it("asserts in the DB-less job that every suite it skipped is one the contract job runs", () => {
    expect(ci).toMatch(/bun run test --reporter=default --reporter=json/);
    expect(ci).toMatch(/bun scripts\/pg-contract\.mjs --require-marked/);
  });

  it("hands the engine's changed paths over unquoted", () => {
    expect(ci).toMatch(/git diff --name-only -z/);
  });

  it("leaves no hardcoded contract path in the runner", () => {
    const executable = ci
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(executable).not.toMatch(/vp test run[^\n]*\.test\.ts/);
  });

  it("names gate files that exist, so a rename cannot quietly drop one from the trigger", () => {
    for (const file of GATE_FILES) {
      expect(existsSync(resolve(process.cwd(), file)), file).toBe(true);
    }
  });
});
