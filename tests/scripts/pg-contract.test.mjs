import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { PgContractError } from "../../scripts/pg-contract/errors.mjs";
import {
  GATE_FILES,
  MARKER,
  MIN_GATED_SUITES,
  assertExecuted,
  assertMarked,
  collectedGlobs,
  collectedSuites,
  contractRelevant,
  declaredSuiteFiles,
  readsDatabaseUrl,
  undeclaredGates,
} from "../../scripts/pg-contract/policy.mjs";
import { classify, readReport } from "../../scripts/pg-contract/report.mjs";
import {
  collectedTestFiles,
  globRoots,
  globToRegExp,
  includeGlobs,
  splitPathList,
} from "../../scripts/pg-contract/tree.mjs";

/**
 * The contract gate's own gate.
 *
 * A `DATABASE_URL`-gated suite is collected by the DB-less run, reported green, and
 * executed by nothing unless the `postgres:contract` job selects it. Every
 * assertion below is about that absence of a run being observable: the derivation
 * is exercised on the live tree, the policy is driven over fixture reports and
 * fixture trees of the shapes a real run produces, and the universe both rules read
 * is the runner's own `test.include`, so a file the runner never collects is in no
 * rule here either.
 */

const DRIVER = "scripts/pg-contract.mjs";
/** The store-seam contract suite: the suite the derivation must find. */
const CONTRACT_SUITE = "packages/infra/src/rag-store-postgres.test.ts";
/** One real file per `test.include` glob, so a glob that stops collecting shows up. */
const ONE_FILE_PER_GLOB = [
  "packages/contracts/src/chat.test.ts",
  "apps/api/src/app.ratelimit.test.ts",
  "tests/scripts/agent-usage-metadata.test.mjs",
  "tests/parity/chat-rule-copy.test.mjs",
];

const read = (rel) => readFileSync(resolve(process.cwd(), rel), "utf8");

const runDriver = (...args) => spawnSync(process.execPath, [DRIVER, ...args], { encoding: "utf8" });

const runDriverIn = (cwd, ...args) =>
  spawnSync(process.execPath, [resolve(process.cwd(), DRIVER), ...args], { cwd, encoding: "utf8" });

/** A vitest JSON report entry for one file, from the statuses its tests reached. */
const entry = (root, file, statuses) => ({
  name: resolve(root, file),
  status: statuses.includes("failed") ? "failed" : "passed",
  assertionResults: statuses.map((status) => ({ status })),
});

const report = (root, entries) => ({ numTotalTests: entries.length, testResults: entries });

/** A config the fixture roots are collected through, in the runner's own shape. */
const fixtureConfig = (
  globs = ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts", "tests/**/*.test.mjs"],
) =>
  `export default defineConfig({\n  test: {\n    include: [\n${globs
    .map((glob) => `      "${glob}",`)
    .join("\n")}\n    ],\n  },\n});\n`;

/**
 * A throwaway tree, so the walk, the derivation and the static rule are driven over
 * known files. It carries a config of its own: the universe is read from there, and a
 * fixture without one would be the empty world every rule passes over.
 */
function fixtureTree(files, config = fixtureConfig()) {
  const root = mkdtempSync(join(tmpdir(), "kajianq-pg-contract-"));
  if (config !== null) writeFileSync(join(root, "vitest.config.ts"), config);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("the collected universe is the runner's, read from its own config", () => {
  it("reads test.include from the real config, and the walk collects each of its globs", () => {
    const globs = collectedGlobs(process.cwd());
    expect(globs.length).toBeGreaterThan(0);
    expect(globRoots(globs)).toEqual(["apps", "packages", "tests"]);
    const suites = collectedSuites(process.cwd());
    expect(suites.length).toBeGreaterThan(100);
    for (const file of [
      ...ONE_FILE_PER_GLOB,
      CONTRACT_SUITE,
      "tests/scripts/pg-contract.test.mjs",
    ]) {
      expect(suites, `${file} is collected by no glob the walk read`).toContain(file);
    }
  });

  it("reads the test block's own include, never the coverage block's", () => {
    // The two arrays sit one inside the other; reading the wrong one yields a
    // different universe without a word, so the coverage block is placed first here.
    const config = `export default defineConfig({\n  coverage: {\n    include: ["packages/**/src/**/*.ts"],\n  },\n  test: {\n    include: ["tests/**/*.test.mjs"],\n  },\n});\n`;
    expect(includeGlobs(config)).toEqual(["tests/**/*.test.mjs"]);
    const fixture = fixtureTree({ "tests/a.test.mjs": "// x\n" }, config);
    try {
      expect(collectedSuites(fixture.root)).toEqual(["tests/a.test.mjs"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("reads no globs from a config that renamed or dropped the key", () => {
    expect(
      includeGlobs("export default defineConfig({\n  test: {\n    exclude: [],\n  },\n});\n"),
    ).toBe(null);
    expect(
      includeGlobs(
        'export default defineConfig({\n  coverage: {\n    include: ["a.ts"],\n  },\n});\n',
      ),
    ).toBe(null);
  });

  it("fails the gate on a root whose universe cannot be read, instead of collecting nothing", () => {
    const bare = fixtureTree({ "tests/a.test.mjs": "// x\n" }, null);
    const keyless = fixtureTree({ "tests/a.test.mjs": "// x\n" }, fixtureConfig([]));
    try {
      expect(() => collectedGlobs(bare.root)).toThrow(/no .*vitest\.config\.ts/);
      expect(() => collectedGlobs(keyless.root)).toThrow(/no test\.include globs/);
      expect(() => declaredSuiteFiles(bare.root)).toThrow(PgContractError);
    } finally {
      bare.cleanup();
      keyless.cleanup();
    }
  });

  it("collects exactly the files the globs name, so the walk is not the wider set", () => {
    const fixture = fixtureTree({
      "packages/infra/src/collected.test.ts": "// x\n",
      // Not under a `src/` directory: no glob collects it, so no rule may read it.
      "packages/infra/collected.test.ts": "// x\n",
      "packages/infra/src/notes.md": "x\n",
      "tests/scripts/collected.test.mjs": "// x\n",
    });
    try {
      expect(collectedTestFiles(fixture.root, ["packages/**/src/**/*.test.ts"])).toEqual([
        "packages/infra/src/collected.test.ts",
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("compiles a glob the way the runner matches one", () => {
    const matcher = globToRegExp("packages/**/src/**/*.{test,prop.test}.ts");
    expect(matcher.test("packages/infra/src/deep/nested/store.test.ts")).toBe(true);
    expect(matcher.test("packages/infra/src/store.prop.test.ts")).toBe(true);
    expect(matcher.test("packages/infra/src/store.ts")).toBe(false);
    // A single star stays inside one segment; a double star crosses any number.
    expect(matcher.test("packages/infra/store.test.ts")).toBe(false);
    expect(globToRegExp("tests/*/*.test.mjs").test("tests/a/b/c.test.mjs")).toBe(false);
  });
});

describe("the static rule reads code, not prose", () => {
  it("knows each spelling a gated suite reaches the variable by", () => {
    expect(readsDatabaseUrl("const url = process.env.DATABASE_URL;\n")).toBe(true);
    expect(readsDatabaseUrl('const url = process.env["DATABASE_URL"];\n')).toBe(true);
    expect(readsDatabaseUrl("const url = process.env['DATABASE_URL'];\n")).toBe(true);
    expect(readsDatabaseUrl("const { DATABASE_URL } = process.env;\n")).toBe(true);
    expect(readsDatabaseUrl("const { DATABASE_URL: url } = process.env;\n")).toBe(true);
    expect(readsDatabaseUrl("const { DATABASE_URL } = env;\n")).toBe(true);
    expect(readsDatabaseUrl("const m = `db ${process.env.DATABASE_URL} up`;\n")).toBe(true);
  });

  it("does not read a mention in a comment or in a fixture string", () => {
    expect(readsDatabaseUrl("// process.env.DATABASE_URL is set in CI\n")).toBe(false);
    expect(readsDatabaseUrl("/**\n * Reads process.env.DATABASE_URL when set.\n */\n")).toBe(false);
    expect(readsDatabaseUrl('// process.env["DATABASE_URL"] is set in CI\n')).toBe(false);
    expect(readsDatabaseUrl('const fixture = "const url = process.env.DATABASE_URL;";\n')).toBe(
      false,
    );
    // An object key is not a read: the config-object shape test files use.
    expect(readsDatabaseUrl('const config = { DATABASE_URL: "postgres://x" };\n')).toBe(false);
  });

  it("keeps reading code after a string or a regex that looks like a comment", () => {
    // Both would put a scan that treats comments first into the wrong state, and the
    // read after them — the direction that leaves a suite in no job — would vanish.
    expect(readsDatabaseUrl('const g = "src/**/*.ts"; const u = process.env.DATABASE_URL;\n')).toBe(
      true,
    );
    expect(readsDatabaseUrl("const re = /['\"]/; const u = process.env.DATABASE_URL;\n")).toBe(
      true,
    );
    expect(readsDatabaseUrl('const s = "https://x"; const u = process.env.DATABASE_URL;\n')).toBe(
      true,
    );
    // A string that never closes ends at its own line, not at the next quote.
    expect(readsDatabaseUrl('const s = "oops;\nconst u = process.env.DATABASE_URL;\n')).toBe(true);
  });

  it("does not see a read that arrives through an alias — the recorded residual", () => {
    // An alias of the environment, or a helper that returns the variable, is not one
    // of the spellings above: a suite that reads it that way and returns early is
    // invisible here and leaves the report nothing to see. Expressing the gate as a
    // skip is the contract; the header states this residual.
    expect(readsDatabaseUrl("const env = process.env;\nconst url = env.DATABASE_URL;\n")).toBe(
      false,
    );
    expect(readsDatabaseUrl('import { dbUrl } from "./env.js";\nconst url = dbUrl();\n')).toBe(
      false,
    );
  });
});

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
    // The static half, on the live tree: a suite that gates by returning early from a
    // test reports a pass and skips nothing, so the report cannot see it and this is
    // the check that does.
    expect(undeclaredGates(declaredSuiteFiles(process.cwd()), process.cwd())).toEqual([]);
  });
});

describe("a report is read, and what is missing is named", () => {
  const root = process.cwd();
  const fixture = fixtureTree({
    "report.json": JSON.stringify(report(root, [entry(root, CONTRACT_SUITE, ["passed"])])),
    "not-a-report.json": JSON.stringify({ success: true }),
    "truncated.json": '{"numTotalTests": 3, "testResu',
  });
  it("reads one, and refuses what is not one, with a message rather than a stack", () => {
    try {
      expect(readReport(join(fixture.root, "report.json")).numTotalTests).toBe(1);
      expect(() => readReport(join(fixture.root, "absent.json"))).toThrow(/no test report/);
      expect(() => readReport(join(fixture.root, "not-a-report.json"))).toThrow(
        /not a vitest JSON report/,
      );
      // A report the runner was killed mid-write on: a thrown gate with a message,
      // never a raw SyntaxError out of the reader.
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
    expect(read.notCollected).toEqual([]);
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
    // The two ways a declaration goes stale are told apart, not merged.
    expect(read.notCollected.map((suite) => suite.file)).toEqual([CONTRACT_SUITE]);
    expect(read.neverSkipped).toEqual([]);
    expect(read.skippedAny).toBe(false);
  });

  it("refuses an empty report, so an extraction that found nothing cannot pass", () => {
    expect(() => classify(report(root, []), declared, root)).toThrow(/pass vacuously/);
  });
});

describe("a DB-less run may only skip suites some job runs", () => {
  /**
   * A fixture world: a tree holding the declared suites — each carrying the marker and
   * reading the variable a gate exists for — plus the report over that same root. The
   * static half of the gate reads the tree and the report half reads the paths, so a
   * report and its tree have to agree on their root.
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
      expect(assertMarked(world.report(gated), world.declared, world.root)).toEqual({
        declared: world.declared,
        diagnostics: [],
      });
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

  it("names a file that reads the variable in code position and skipped nothing at all", () => {
    // The early-return shape, in the spelling that hides hardest: the report is a
    // clean run with no skip in it, and only the tree shows the gate.
    const world = gatedWorld({
      files: {
        "apps/api/src/destructured.test.ts":
          "const { DATABASE_URL } = process.env;\nif (!DATABASE_URL) return;\n",
      },
    });
    try {
      expect(undeclaredGates(world.declared, world.root)).toEqual([
        "apps/api/src/destructured.test.ts",
      ]);
      const ran = world.entry(DECLARED, ["skipped"]);
      expect(() => assertMarked(world.report(ran), world.declared, world.root)).toThrow(
        /apps\/api\/src\/destructured\.test\.ts/,
      );
      expect(() => assertMarked(world.report(ran), world.declared, world.root)).toThrow(
        /returning early/,
      );
      // Declaring it settles the static half for that file.
      expect(
        undeclaredGates(world.declared.concat("apps/api/src/destructured.test.ts"), world.root),
      ).toEqual([]);
    } finally {
      world.cleanup();
    }
  });

  it("leaves the file the runner never collects alone, and asks nothing of it", () => {
    // No glob collects this one, so no job runs it and no rule here reads it: the gate
    // cannot judge what the runner never loads.
    const world = gatedWorld({
      files: { "packages/infra/local-probe.test.ts": "const url = process.env.DATABASE_URL;\n" },
    });
    try {
      expect(undeclaredGates(world.declared, world.root)).toEqual([]);
      const gated = world.entry(DECLARED, ["skipped"]);
      expect(() => assertMarked(world.report(gated), world.declared, world.root)).not.toThrow();
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

  it("notes a declaration that gated nothing, rather than failing a file into a corner", () => {
    // Declaring is the remedy for a file the static rule cannot tell from a reader,
    // so a marker that turns out stale is a note: a red here would leave no way out
    // but editing text the rule matched on.
    const world = gatedWorld({
      declared: ["tests/scripts/gated-a.test.mjs", "tests/scripts/gated-b.test.mjs"],
    });
    try {
      const gated = world.entry("tests/scripts/gated-a.test.mjs", ["skipped"]);
      const ran = world.entry("tests/scripts/gated-b.test.mjs", ["passed"]);
      const { diagnostics } = assertMarked(world.report(gated, ran), world.declared, world.root);
      expect(diagnostics).toEqual([
        `tests/scripts/gated-b.test.mjs declares "${MARKER}" but skipped nothing in this run`,
      ]);
    } finally {
      world.cleanup();
    }
  });

  it("notes a declaration the run never collected, and names that case for what it is", () => {
    const world = gatedWorld({
      declared: ["tests/scripts/gated-a.test.mjs", "tests/scripts/gated-b.test.mjs"],
    });
    try {
      const gated = world.entry("tests/scripts/gated-a.test.mjs", ["skipped"]);
      const { diagnostics } = assertMarked(world.report(gated), world.declared, world.root);
      expect(diagnostics).toEqual([
        `tests/scripts/gated-b.test.mjs declares "${MARKER}" but this run never collected it`,
      ]);
    } finally {
      world.cleanup();
    }
  });

  it("prints those notes through the driver while still passing the gate", () => {
    const world = gatedWorld({
      declared: ["tests/scripts/gated-a.test.mjs", "tests/scripts/gated-b.test.mjs"],
    });
    try {
      const reportPath = join(world.root, "report.json");
      writeFileSync(
        reportPath,
        JSON.stringify(
          world.report(
            world.entry("tests/scripts/gated-a.test.mjs", ["skipped"]),
            world.entry("tests/scripts/gated-b.test.mjs", ["passed"]),
          ),
        ),
      );
      const ran = runDriverIn(world.root, "--require-marked", "report.json");
      expect(ran.status, ran.stderr).toBe(0);
      expect(ran.stderr).toMatch(/note: .*gated-b\.test\.mjs/);
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

  it("refuses an empty declaration, so a derivation that found nothing cannot pass either", () => {
    const ran = entry(root, CONTRACT_SUITE, ["passed"]);
    expect(() => assertExecuted(report(root, [ran]), [], root)).toThrow(/no declared suite/);
    expect(() => assertMarked(report(root, [ran]), [], root)).toThrow(/no declared suite/);
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
    // `git diff -z` is what keeps a non-ASCII path unquoted; a quoted one matches no
    // declared suite, and the job would silently not engage.
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

  it("splits a changed list on the delimiter it carries, so a path may hold a newline", () => {
    expect(splitPathList("a\0b\0")).toEqual(["a", "b"]);
    expect(splitPathList("a\nb\n")).toEqual(["a", "b"]);
    // A NUL-separated list keeps its newline-bearing path whole; splitting on both
    // delimiters would hand the policy two paths, neither of them the declared one.
    expect(splitPathList("tests/scripts/a\nb.test.mjs\0docs/x.md\0")).toEqual([
      "tests/scripts/a\nb.test.mjs",
      "docs/x.md",
    ]);
    expect(splitPathList("")).toEqual([]);
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
