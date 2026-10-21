import { afterEach, describe, expect, it } from "vite-plus/test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DOCS_ONLY_PATTERNS,
  DRILL_ENTRY,
  DRILL_SPAWN_SCRIPTS,
  DRILL_SQL,
  FILE_ENTRIES,
  InvariantRefusal,
  POLICED_WORKFLOW,
  REPO_ROOT,
  WEB_ENTRY,
  assertDeployEntrySet,
  assertDrillEntrySet,
  buildClosure,
  collectRepoFiles,
  compilePattern,
  compilePatterns,
  deployEntries,
  deriveTestClass,
  drillEntries,
  extractSpecifiers,
  firstMatch,
  importChain,
  loadWorkspaceIndex,
  parsePathsIgnore,
  resolveBareSpecifier,
  resolvePathSpecifier,
  stripComments,
} from "../../scripts/check-paths-ignore-invariant.mjs";

/**
 * The gate for the three workflows' paths-ignore classes.
 *
 * The traps this suite is built around, named before the assertions:
 *   falsification   a matched path that IS reachable from an execution entry
 *                   must exit non-zero — a suite that only ever passes the
 *                   clean tree tests nothing;
 *   rename          the production module is moved into the class by a NAME
 *                   change (`prod-test-utils.ts`), so any check built from a
 *                   name list would pass it — the closure must catch it;
 *   kept input      a workflow that refuses to ignore its own suite must fail
 *                   when that suite leaves the closure, so the exception cannot
 *                   outlive the reason for it;
 *   PR half         a pull_request filter wider than the docs class is refused:
 *                   a path-ignored workflow never reports, so the widening is a
 *                   gating decision, not a trigger edit;
 *   comment         a file containing the text of an import of a matched
 *                   module, inside a comment, must stay green — that is the
 *                   difference between "imports" and "mentions";
 *   importer class  a matched helper imported only by `*.test.ts` files must
 *                   stay green: the class exists to be imported by tests;
 *   glob            `*` must never cross `/`, `**` must, and `**` before a
 *                   slash must match zero directories;
 *   fail-closed     unreadable input refuses non-zero, never passes.
 */
const CLI = resolve(REPO_ROOT, "scripts/check-paths-ignore-invariant.mjs");
const CLI_URL = pathToFileURL(CLI).href;
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

/** A git-backed fixture tree: `git ls-files` is the match set's real source. */
function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "paths-ignore-399-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function runCli(root) {
  const result = spawnSync("bun", [CLI, "--root", root], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** One trigger's pattern list, as YAML. */
function patternsYaml(patterns) {
  return patterns.map((pattern) => `      - ${JSON.stringify(pattern)}`).join("\n");
}

/** One workflow's `on:` block; an absent `pullRequest` means no PR trigger. */
function workflowYaml(name, { push, pullRequest }) {
  return (
    `name: ${name}\non:\n` +
    (pullRequest ? `  pull_request:\n    paths-ignore:\n${patternsYaml(pullRequest)}\n` : "") +
    `  push:\n    branches: [main]\n    paths-ignore:\n${patternsYaml(push)}\n` +
    "  workflow_dispatch:\n"
  );
}

/** The test class the staging fixture defines; the docs class the PR halves carry. */
const DOCS = DOCS_ONLY_PATTERNS;
const TEST_CLASS = [
  "tests/**",
  "**/*.test.ts",
  "**/*.test.mjs",
  "**/test-utils/**",
  "**/*test-utils*",
  "**/test-fixtures*",
  "vitest.config.ts",
  "playwright.config.ts",
];
/** The class source carries the pinned docs class plus the test class it defines. */
const STAGING_PUSH = [...DOCS, ...TEST_CLASS];
/** E2E keeps its own BDD suite and config out of the ignore list. */
const E2E_KEEP = ["tests/**", "playwright.config.ts"];
const E2E_PUSH = STAGING_PUSH.filter((pattern) => !E2E_KEEP.includes(pattern));
const DRILL_PUSH = STAGING_PUSH;

const WORKFLOW = workflowYaml("Staging", { push: STAGING_PUSH });

const DEPLOY_SH = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "bun run build:web",
  'bun build "${REPO_DIR}/apps/api/src/boot.ts" --target=bun --outfile "${STAGE}/api/index.js"',
  'bun build "${REPO_DIR}/apps/api/src/cleanup.ts" --target=bun --outfile "${STAGE}/api/cleanup.js"',
  'bun build "${REPO_DIR}/provision/vps/backup/kajianq-backup.mjs" --target=bun --outfile "${STAGE}/api/backup.js"',
  "",
].join("\n");

/**
 * The drill fixture models the real drill's execution set: two imports, three psql
 * invocation sites (the inline, stdin and file helpers), two scripts spawned through
 * `run("bun", …)` and one migration applied through `psqlFile`. The spawned scripts
 * and the applied file are NOT imports — that is the A1 gap this fixture has to see.
 */
const DRILL_LINES = [
  'import { RECLAIM_SQL } from "./lib.mjs";',
  "",
  'const HERE = new URL("./", import.meta.url);',
  "const MIGRATIONS = `${REPO_ROOT}packages/infra/migrations/0001_init.sql`;",
  "",
  "const psql = (url, statement) =>",
  '  run("psql", ["-At", "-c", statement], pgEnv(url));',
  "const psqlVar = (url, statement) =>",
  '  spawnSync("psql", ["-At", "-f", "-"], { input: statement });',
  "const psqlFile = (url, file) =>",
  '  run("psql", ["-At", "-f", file], pgEnv(url));',
  "",
  "psqlFile(sourceUrl, MIGRATIONS);",
  "const backupOut = run(",
  '  "bun",',
  '  [`${HERE}kajianq-backup.mjs`, "--label", LABEL],',
  ");",
  "const restoreOut = run(",
  '  "bun",',
  '  [`${HERE}kajianq-restore.mjs`, "--label", LABEL],',
  ");",
  "const eraseOut = run(",
  '  "bun",',
  '  [`${HERE}kajianq-restore.mjs`, "--label", LABEL, "--erase-user", SUBJECT],',
  ");",
  "export const drill = () => backupOut || restoreOut || eraseOut || RECLAIM_SQL;",
];
const DRILL_MJS = `${DRILL_LINES.join("\n")}\n`;

const PLAYWRIGHT_CONFIG_TEXT = [
  "export default {",
  '  features: "tests/features/**/*.feature",',
  '  steps: "tests/steps/**/*.ts",',
  '  webServer: { command: "bun run build && bun apps/api/src/boot.ts" },',
  "};",
  "",
].join("\n");

/**
 * The green tree: every class member exists, and none of them is imported by a
 * deploy entry. `app.test.ts` imports the domain pack's test-utils, and
 * `app.tsx` carries an import statement inside a comment.
 */
const BASE = {
  ".github/workflows/staging.yml": WORKFLOW,
  ".github/workflows/e2e.yml": workflowYaml("E2E", { push: E2E_PUSH, pullRequest: DOCS }),
  ".github/workflows/vps-restore-drill.yml": workflowYaml("VPS restore drill", {
    push: DRILL_PUSH,
    pullRequest: DOCS,
  }),
  // Carries no filter: the inventory line must name it rather than hide it.
  ".github/workflows/ci.yml": "name: CI\non:\n  push:\n  pull_request:\n",
  "provision/vps/deploy/deploy.sh": DEPLOY_SH,
  "provision/vps/backup/restore-drill.mjs": DRILL_MJS,
  "playwright.config.ts": PLAYWRIGHT_CONFIG_TEXT,
  "tests/features/chat.feature": "Feature: chat\n",
  "tests/steps/chat.steps.ts": "export const steps = 1;\n",
  "package.json": `${JSON.stringify(
    { name: "fixture", private: true, workspaces: ["apps/*", "packages/*"] },
    null,
    2,
  )}\n`,
  "vitest.config.ts": "export default {};\n",
  "apps/web/index.html":
    '<!doctype html>\n<script type="module" src="/src/main.tsx"></script>\n' +
    '<link rel="icon" href="/favicon.svg" />\n',
  "apps/web/public/favicon.svg": "<svg></svg>\n",
  "apps/web/src/main.tsx":
    'import { App } from "./app";\nimport "./styles.css";\nexport default App;\n',
  "apps/web/src/app.tsx":
    '// import { renderApp } from "./components/app-test-utils";\nexport const App = () => null;\n',
  "apps/web/src/styles.css": '@import "./theme.css";\nbody { background: url("/favicon.svg"); }\n',
  "apps/web/src/theme.css": ":root { color-scheme: light; }\n",
  "apps/web/src/components/app-test-utils.ts": "export const renderApp = () => null;\n",
  "apps/api/src/boot.ts": 'import { createApi } from "./app";\ncreateApi();\n',
  "apps/api/src/app.ts":
    'import { domain } from "@app/kajianq-domain";\nexport const createApi = () => domain;\n',
  "apps/api/src/app.test.ts":
    'import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";\n',
  "apps/api/src/cleanup.ts": 'import { run } from "./lib/scheduled";\nrun();\n',
  "apps/api/src/lib/scheduled.ts": "export const run = () => {};\n",
  "provision/vps/backup/kajianq-backup.mjs":
    'import { lib } from "./lib.mjs";\nimport { record } from "./provenance.mjs";\nlib(record);\n',
  "provision/vps/backup/kajianq-restore.mjs": 'import { lib } from "./lib.mjs";\nlib();\n',
  "provision/vps/backup/provenance.mjs": "export const record = 1;\n",
  "provision/vps/backup/lib.mjs": "export const lib = () => {};\n",
  "packages/infra/migrations/0001_init.sql": "CREATE TABLE users (id uuid primary key);\n",
  "packages/kajianq-domain/package.json": `${JSON.stringify({
    name: "@app/kajianq-domain",
    exports: { ".": "./src/index.ts", "./test-utils/*": "./src/test-utils/*" },
  })}\n`,
  "packages/kajianq-domain/src/index.ts": "export const domain = 1;\n",
  "packages/kajianq-domain/src/test-utils/memory-rag-store.ts":
    "export const createMemoryRagStore = () => ({});\n",
  "test-utils/helper.ts": "export const helper = 1;\n",
  "test-fixtures-chat.ts": "export const chatFixture = 1;\n",
};

/** BASE with overrides merged in and files removed. */
function tree(overrides = {}, removed = []) {
  const files = { ...BASE, ...overrides };
  for (const key of removed) delete files[key];
  return files;
}

/** The drill fixture with one extra line appended — a mutation the gate must see. */
function drillWith(extra) {
  return `${DRILL_MJS}${extra}\n`;
}

/** The JSON subset `parsePathsIgnore` accepts as an injected parser. */
const jsonParser = (text) => JSON.parse(text);

describe("#399 GitHub glob semantics, not the shell's", () => {
  const cases = [
    // The two wildcards, and the zero-directory `**` case.
    ["docs/**", "docs/a.md", true],
    ["docs/**", "docs/nested/a.md", true],
    ["*.md", "docs/a.md", false],
    ["**.md", "docs/a.md", true],
    ["**", "a/b/c", true],
    ["**/test-utils/**", "test-utils/x.ts", true],
    ["**/test-utils/**", "packages/rate/src/test-utils/x.ts", true],
    ["**/*test-utils*", "apps/web/src/components/app-test-utils.ts", true],
    ["**/*test-utils*", "apps/web/src/components/app-test-utils/deep.ts", false],
    ["**/test-fixtures*", "packages/infra/src/providers/test-fixtures.ts", true],
    ["**/test-fixtures*", "test-fixtures.ts", true],
    ["tests/**", "tests/scripts/x.test.mjs", true],
    ["**/*.test.ts", "apps/web/src/app.test.ts", true],
    // Anchored to the whole path: a bare filename is the root file only.
    ["vitest.config.ts", "vitest.config.ts", true],
    ["vitest.config.ts", "apps/web/vitest.config.ts", false],
  ];

  it.each(cases)("%s × %s → %s", (pattern, file, expected) => {
    expect(compilePattern(pattern).test(file)).toBe(expected);
  });

  it("is deliberately wider than GitHub on case and leading dots (over-report only)", () => {
    // Documented bias: a wider matcher can only turn a silent skip into a red
    // gate, never the reverse.
    expect(compilePattern("**/test-utils/**").test("Test-Utils/x.ts")).toBe(true);
    expect(compilePattern("**.md").test(".agents/x.md")).toBe(true);
  });

  it("refuses glob syntax it does not model instead of guessing", () => {
    expect(() => compilePattern("!docs/**")).toThrow(InvariantRefusal);
    expect(() => compilePattern("!docs/**")).toThrow(/negated pattern/);
    expect(() => compilePattern("a?b")).toThrow(/does not model/);
    expect(() => compilePattern("a+b")).toThrow(/does not model/);
    expect(() => compilePattern("a[0-9]b")).toThrow(/does not model/);
    expect(() => compilePattern("**/*.{ts,mjs}")).toThrow(/does not model/);
    expect(() => compilePattern("")).toThrow(/empty paths-ignore pattern/);
  });
});

describe("#399 the match set is the class's real members", () => {
  it("matches every test-support member the repo actually has", () => {
    // The class members this check relies on, matched by the real patterns.
    const compiled = compilePatterns([
      "**/test-utils/**",
      "**/*test-utils*",
      "**/test-fixtures*",
      "vitest.config.ts",
      "playwright.config.ts",
    ]);
    const matched = collectRepoFiles(REPO_ROOT).filter((file) => firstMatch(compiled, file));
    for (const member of [
      "packages/rate/src/test-utils/ed25519-keypair.ts",
      "packages/kajianq-domain/src/test-utils/memory-rag-store.ts",
      "apps/web/src/components/app-test-utils.ts",
      "packages/infra/src/providers/test-fixtures.ts",
      "vitest.config.ts",
      "playwright.config.ts",
    ]) {
      expect(matched, member).toContain(member);
    }
  });
});

describe("#399 trigger parsing refuses rather than passing", () => {
  it("reads the pattern list from a parsed document", () => {
    const patterns = parsePathsIgnore(
      JSON.stringify({ on: { push: { "paths-ignore": ["docs/**", "tests/**"] } } }),
      jsonParser,
    );
    expect(patterns).toEqual(["docs/**", "tests/**"]);
  });

  it("reads a pull_request filter with the event selector", () => {
    const patterns = parsePathsIgnore(
      JSON.stringify({ on: { pull_request: { "paths-ignore": ["docs/**"] } } }),
      jsonParser,
      "pull_request",
    );
    expect(patterns).toEqual(["docs/**"]);
  });

  it("refuses an absent pull_request trigger", () => {
    expect(() =>
      parsePathsIgnore(
        JSON.stringify({ on: { push: { "paths-ignore": ["docs/**"] } } }),
        jsonParser,
        "pull_request",
      ),
    ).toThrow(/no `on\.pull_request` trigger/);
  });

  it("accepts a document keyed by YAML 1.1's boolean `on`", () => {
    const patterns = parsePathsIgnore(
      JSON.stringify({ true: { push: { "paths-ignore": ["docs/**"] } } }),
      jsonParser,
    );
    expect(patterns).toEqual(["docs/**"]);
  });

  it("refuses a document that is not a mapping", () => {
    expect(() => parsePathsIgnore('["a"]', jsonParser)).toThrow(/not a mapping/);
  });

  it("refuses an absent on.push block", () => {
    expect(() =>
      parsePathsIgnore(JSON.stringify({ on: { workflow_dispatch: {} } }), jsonParser),
    ).toThrow(/no `on\.push` trigger/);
  });

  it("refuses an absent, mistyped or empty pattern list", () => {
    expect(() => parsePathsIgnore(JSON.stringify({ on: { push: {} } }), jsonParser)).toThrow(
      /`on\.push\.paths-ignore` is absent/,
    );
    expect(() =>
      parsePathsIgnore(JSON.stringify({ on: { push: { "paths-ignore": "docs/**" } } }), jsonParser),
    ).toThrow(/not a list/);
    expect(() =>
      parsePathsIgnore(JSON.stringify({ on: { push: { "paths-ignore": [] } } }), jsonParser),
    ).toThrow(/is empty/);
    expect(() =>
      parsePathsIgnore(
        JSON.stringify({ on: { push: { "paths-ignore": ["docs/**", 7] } } }),
        jsonParser,
      ),
    ).toThrow(/not a non-empty string/);
  });

  it("refuses a paths inclusion filter instead of reading it as an ignore list", () => {
    expect(() =>
      parsePathsIgnore(
        JSON.stringify({ on: { push: { paths: ["src/**"], "paths-ignore": ["docs/**"] } } }),
        jsonParser,
      ),
    ).toThrow(/carries a `paths` inclusion filter alongside `paths-ignore`/);
  });

  it("refuses a document the parser itself rejects", () => {
    const boom = () => {
      throw new Error("bad yaml");
    };
    expect(() => parsePathsIgnore("on: [", boom)).toThrow(
      /cannot parse the workflow YAML: bad yaml/,
    );
  });

  it("refuses when no YAML parser is available at runtime", () => {
    // The gate must not silently pass on a runtime that cannot read its input.
    const code =
      `Bun.YAML = undefined;\n` +
      `const m = await import(${JSON.stringify(CLI_URL)});\n` +
      `try { await m.parsePathsIgnore("on: {}"); console.log("PARSED"); }\n` +
      `catch (error) { console.log("REFUSED: " + error.message); }\n`;
    const out = execFileSync("bun", ["-e", code], { encoding: "utf8" });
    expect(out).toContain("REFUSED: no YAML parser available");
  });
});

describe("#399 import extraction follows edges, not mentions", () => {
  it("drops comments but keeps the specifiers that live in strings", () => {
    const stripped = stripComments(
      '// import { a } from "./test-utils/comment";\n/* import "./test-utils/block"; */\n' +
        'import { b } from "./real";\nconst url = "http://x";\n',
    );
    expect(stripped).not.toContain("test-utils/comment");
    expect(stripped).not.toContain("test-utils/block");
    expect(stripped).toContain('"./real"');
  });

  it("extracts every module edge form as a `module` edge", () => {
    const specs = extractSpecifiers(
      [
        'import { a } from "./a";',
        'import "./side-effect";',
        'import type { B } from "./b";',
        'export * from "./c";',
        'export { d } from "./d";',
        'const e = await import("./e");',
        'const f = require("./f");',
      ].join("\n"),
      "ts",
    );
    expect(specs.map((edge) => edge.spec)).toEqual([
      "./a",
      "./side-effect",
      "./b",
      "./c",
      "./d",
      "./e",
      "./f",
    ]);
    expect(specs.every((edge) => edge.kind === "module")).toBe(true);
  });

  it("does not follow a require whose specifier is not a literal (a disclosed gap)", () => {
    expect(extractSpecifiers("const a = require(name);", "ts")).toEqual([]);
    expect(extractSpecifiers("const b = require(`./${name}`);", "ts")).toEqual([]);
  });

  it("extracts CSS imports as modules and url() assets as assets", () => {
    const specs = extractSpecifiers(
      '@import "./theme.css";\nbody { background: url("/x.svg"); }',
      "css",
    );
    expect(specs).toEqual([
      { spec: "./theme.css", kind: "module" },
      { spec: "/x.svg", kind: "asset" },
    ]);
  });

  it("extracts HTML script and asset references", () => {
    const specs = extractSpecifiers(
      '<script type="module" src="/src/main.tsx"></script><link rel="icon" href="/favicon.svg" />',
      "html",
    );
    expect(specs).toEqual([
      { spec: "/src/main.tsx", kind: "asset" },
      { spec: "/favicon.svg", kind: "asset" },
    ]);
  });
});

describe("#399 closure resolution", () => {
  it("resolves relative specifiers against the importer, not the project root", () => {
    expect(resolvePathSpecifier("./app", join(REPO_ROOT, "apps/api/src/boot.ts"), REPO_ROOT)).toBe(
      join(REPO_ROOT, "apps/api/src/app.ts"),
    );
  });

  it("resolves /-absolute refs through the Vite root and its public/ dir", () => {
    const webRoot = join(REPO_ROOT, "apps/web");
    expect(resolvePathSpecifier("/src/main.tsx", join(webRoot, "index.html"), webRoot)).toBe(
      join(webRoot, "src/main.tsx"),
    );
    expect(resolvePathSpecifier("/favicon.svg", join(webRoot, "index.html"), webRoot)).toBe(
      join(webRoot, "public/favicon.svg"),
    );
  });

  it("resolves workspace package specifiers through their exports map", () => {
    const index = loadWorkspaceIndex(REPO_ROOT);
    const from = join(REPO_ROOT, "apps/api/src/boot.ts");
    expect(resolveBareSpecifier("@app/contracts", index, REPO_ROOT, from).file).toBe(
      join(REPO_ROOT, "packages/contracts/src/index.ts"),
    );
    expect(
      resolveBareSpecifier("@app/rate/test-utils/ed25519-keypair", index, REPO_ROOT, from).file,
    ).toBe(join(REPO_ROOT, "packages/rate/src/test-utils/ed25519-keypair.ts"));
  });

  it("treats node_modules dependencies as external leaves and refuses the unknown", () => {
    const index = loadWorkspaceIndex(REPO_ROOT);
    const mainTsx = join(REPO_ROOT, "apps/web/src/main.tsx");
    expect(resolveBareSpecifier("react", index, REPO_ROOT, mainTsx).external).toBe(true);
    expect(() => resolveBareSpecifier("not-a-real-dep", index, REPO_ROOT, mainTsx)).toThrow(
      /cannot resolve bare specifier/,
    );
  });

  it("walks each of the four deploy entries to its known modules", () => {
    // Evidence that every deploy entry really is walked (not just resolved):
    // one module per entry whose presence only an import walk can produce.
    const { closure } = buildClosure(deployEntries(), REPO_ROOT);
    for (const file of [
      "apps/web/index.html",
      "apps/web/src/main.tsx",
      "apps/web/src/styles.css",
      "apps/web/public/favicon.svg",
      "apps/api/src/boot.ts",
      "apps/api/src/app.ts",
      "apps/api/src/cleanup.ts",
      "apps/api/src/lib/scheduled.ts",
      "provision/vps/backup/kajianq-backup.mjs",
      "provision/vps/backup/lib.mjs",
    ]) {
      expect([...closure.keys()], file).toContain(join(REPO_ROOT, file));
    }
    // The web entry reaches a workspace package; so does the API entry.
    expect([...closure.keys()]).toContain(join(REPO_ROOT, "packages/contracts/src/index.ts"));
  });

  it("prints an import chain from the entry to the hit", () => {
    const dir = makeRepo(
      tree({
        "apps/api/src/app.ts":
          'import { helper } from "../../../test-utils/helper";\nexport const createApi = () => helper;\n',
      }),
    );
    const { closure } = buildClosure(deployEntries(), dir);
    const chain = importChain(join(dir, "test-utils/helper.ts"), closure, dir);
    expect(chain).toEqual(["apps/api/src/boot.ts", "apps/api/src/app.ts", "test-utils/helper.ts"]);
  });
});

describe("#399 the deploy entry set cannot drift unguarded", () => {
  it("accepts the real deploy.sh", () => {
    const deploySh = execFileSync("git", ["show", "HEAD:provision/vps/deploy/deploy.sh"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(() => assertDeployEntrySet(deploySh)).not.toThrow();
  });

  it("knows exactly the four entries deploy.sh builds, web included", () => {
    expect(deployEntries().map((entry) => entry.file)).toEqual([WEB_ENTRY, ...FILE_ENTRIES]);
    expect(FILE_ENTRIES).toHaveLength(3);
  });

  it("refuses a deploy.sh that stops naming an entry", () => {
    expect(() =>
      assertDeployEntrySet(DEPLOY_SH.replace("apps/api/src/cleanup.ts", "apps/api/src/nightly.ts")),
    ).toThrow(/no longer names apps\/api\/src\/cleanup\.ts/);
  });

  it("refuses a deploy.sh that grows a fifth build", () => {
    expect(() => assertDeployEntrySet(`${DEPLOY_SH}bun build extra.ts\n`)).toThrow(
      /runs `bun build` 4 time\(s\)/,
    );
  });

  it("refuses a deploy.sh that no longer builds the web artifact", () => {
    expect(() =>
      assertDeployEntrySet(DEPLOY_SH.replace("bun run build:web", "bun run build")),
    ).toThrow(/`bun run build:web` is not in/);
  });
});

describe("#399 falsification — a matched path inside a deploy closure fails", () => {
  it("T1: a relative import from the API entry into test-utils/ exits non-zero, with the chain", () => {
    const dir = makeRepo(
      tree({
        "apps/api/src/app.ts":
          'import { helper } from "../../../test-utils/helper";\nexport const createApi = () => helper;\n',
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain('"**/test-utils/**" matches test-utils/helper.ts');
    expect(stderr).toContain(
      "reachable from deploy entry apps/api/src/boot.ts: " +
        "apps/api/src/boot.ts → apps/api/src/app.ts → test-utils/helper.ts",
    );
  });

  it("T2: a RENAME that moves a production module into the class (web entry) exits non-zero", () => {
    // A name-list check passes this: the module keeps its importers and changes
    // only its path. The import walk does not.
    const dir = makeRepo(
      tree({
        "apps/web/src/main.tsx":
          'import { App } from "./lib/prod-test-utils";\nexport default App;\n',
        "apps/web/src/lib/prod-test-utils.ts": "export const App = () => null;\n",
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain('"**/*test-utils*" matches apps/web/src/lib/prod-test-utils.ts');
    expect(stderr).toContain(
      "reachable from deploy entry apps/web/index.html: " +
        "apps/web/index.html → apps/web/src/main.tsx → apps/web/src/lib/prod-test-utils.ts",
    );
  });

  it("T1: a transitive re-export into a test-fixtures* name exits non-zero", () => {
    const dir = makeRepo(
      tree({
        "apps/api/src/lib/scheduled.ts": 'export * from "../../../../test-fixtures-chat";\n',
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain('"**/test-fixtures*" matches test-fixtures-chat.ts');
  });

  it("T1: a literal dynamic import into test-utils/ exits non-zero", () => {
    const dir = makeRepo(
      tree({
        "apps/api/src/lib/scheduled.ts":
          'export const run = async () => (await import("../../../../test-utils/dynamic")).run();\n',
        "test-utils/dynamic.ts": "export const run = () => {};\n",
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain('"**/test-utils/**" matches test-utils/dynamic.ts');
  });

  it("T1: a workspace subpath export into a test-utils dir is followed, not skipped", () => {
    const dir = makeRepo(
      tree({
        "apps/api/src/app.ts":
          'import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";\n' +
          "export const createApi = () => createMemoryRagStore;\n",
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain(
      '"**/test-utils/**" matches packages/kajianq-domain/src/test-utils/memory-rag-store.ts',
    );
    expect(stderr).toContain("apps/api/src/boot.ts → apps/api/src/app.ts");
  });
});

describe("#399 the drill's execution set is walked, not just its imports", () => {
  it("lists the drill's spawned scripts and migration as entries", () => {
    expect(drillEntries().map((entry) => entry.file)).toEqual([
      DRILL_ENTRY,
      ...DRILL_SPAWN_SCRIPTS,
      DRILL_SQL,
    ]);
  });

  it("asserts the real drill still names every file this check walks", () => {
    const drill = execFileSync("git", ["show", `HEAD:${DRILL_ENTRY}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(() => assertDrillEntrySet(drill)).not.toThrow();
  });

  it("walks four drill entries and six files, not the drill and its import alone", () => {
    const { status, stdout } = runCli(makeRepo(tree()));
    expect(status).toBe(0);
    const evidence =
      /vps-restore-drill\.yml on\.push\.paths-ignore \(\d+ patterns, \d+ matched paths\) × static import closure of (\d+) entries \((\d+) files\)/.exec(
        stdout,
      );
    expect(evidence, stdout).not.toBeNull();
    expect(Number(evidence[1])).toBe(4);
    expect(Number(evidence[2])).toBe(6);
  });

  it("T1: a drill that spawns a new file the ignore list covers refuses, naming it", () => {
    const dir = makeRepo(
      tree({
        "provision/vps/backup/restore-drill.mjs": drillWith(
          'run("bun", [`${HERE}test-fixtures-drill.mjs`]);',
        ),
        // Matches the class's `**/test-fixtures*`, so the gate must not certify it.
        "provision/vps/backup/test-fixtures-drill.mjs": "export const fixture = 1;\n",
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain(
      'executes "provision/vps/backup/test-fixtures-drill.mjs", which this check does not walk',
    );
    expect(stderr).toContain("add it to the drill entries deliberately");
  });

  it("T1: a fourth bun spawn refuses even when its target is not a path literal", () => {
    const dir = makeRepo(
      tree({
        "provision/vps/backup/restore-drill.mjs": drillWith(
          'run("bun", ["test-fixtures-drill.mjs"]);',
        ),
        "test-fixtures-drill.mjs": "export const fixture = 1;\n",
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain("runs `bun` 4 time(s) but this check knows 3 spawn site(s)");
    expect(stderr).toContain("(DRILL_BUN_SPAWNS)");
    expect(stderr).toContain("bump DRILL_BUN_SPAWNS");
  });

  it("T1: a fifth file applied as a plain relative psqlFile literal refuses, naming it", () => {
    // The reviewer's repro: no `${REPO_ROOT}` prefix, so a pattern-only pin never
    // sees it, while the gate's own `**/test-fixtures*` matches the applied file.
    const dir = makeRepo(
      tree({
        "provision/vps/backup/restore-drill.mjs": drillWith(
          'psqlFile(sourceUrl, "packages/infra/migrations/test-fixtures-0002.sql");',
        ),
        "packages/infra/migrations/test-fixtures-0002.sql": "SELECT 1;\n",
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain(
      'executes "packages/infra/migrations/test-fixtures-0002.sql", which this check does not walk',
    );
  });

  it("T1: a psqlFile argument this check cannot read refuses instead of passing", () => {
    const dir = makeRepo(
      tree({
        "provision/vps/backup/restore-drill.mjs": DRILL_MJS.replace(
          "psqlFile(sourceUrl, MIGRATIONS);",
          "psqlFile(sourceUrl, argv[2]);",
        ),
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain("a form this check cannot read");
    expect(stderr).toContain("file application must be a string literal");
  });

  it("T1: a psql file application reached through an alias refuses", () => {
    const dir = makeRepo(
      tree({
        "provision/vps/backup/restore-drill.mjs": drillWith(
          "const applyFile = psqlFile;\napplyFile(sourceUrl, MIGRATIONS);",
        ),
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain("references psqlFile in a form this check cannot read");
  });

  it("T1: a second psql file application refuses, naming DRILL_PSQL_FILE_SITES", () => {
    const dir = makeRepo(
      tree({
        "provision/vps/backup/restore-drill.mjs": drillWith("psqlFile(sourceUrl, MIGRATIONS);"),
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain(
      "applies a file through psql 2 time(s) but this check knows 1 application site(s) " +
        "(DRILL_PSQL_FILE_SITES)",
    );
  });

  it("T1: a new psql invocation site refuses, naming DRILL_PSQL_SITES", () => {
    const dir = makeRepo(
      tree({
        "provision/vps/backup/restore-drill.mjs": drillWith(
          'run("psql", ["-At", "-c", "SELECT 1"]);',
        ),
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain(
      "invokes `psql` 4 time(s) but this check knows 3 site(s) (DRILL_PSQL_SITES)",
    );
  });

  it("T1: an ignored helper imported by a spawned script refuses, with its chain", () => {
    // `kajianq-restore.mjs` is spawned by the drill and is not a deploy artifact, so
    // only the drill's closure can reach it.
    const dir = makeRepo(
      tree({
        "provision/vps/backup/kajianq-restore.mjs":
          'import { helper } from "../../../test-utils/helper";\nexport const restore = helper;\n',
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain('"**/test-utils/**" matches test-utils/helper.ts');
    expect(stderr).toContain(
      "reachable from execution entry provision/vps/backup/kajianq-restore.mjs: " +
        "provision/vps/backup/kajianq-restore.mjs → test-utils/helper.ts",
    );
  });
});

describe("#399 the Playwright selection this check walks is pinned", () => {
  it("T1: refuses a config that moved the BDD suite to another directory", () => {
    const dir = makeRepo(
      tree({
        "playwright.config.ts":
          'export default { features: "e2e/features/**/*.feature", ' +
          'steps: "tests/steps/**/*.ts", webServer: { command: "bun apps/api/src/boot.ts" } };\n',
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain("playwright.config.ts no longer names tests/features/**/*.feature");
  });

  it("T1: refuses a config whose webServer stopped booting the walked API entry", () => {
    const dir = makeRepo(
      tree({
        "playwright.config.ts": PLAYWRIGHT_CONFIG_TEXT.replace(
          "bun run build && bun apps/api/src/boot.ts",
          "bun run build && bun apps/api/src/server.ts",
        ),
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain("playwright.config.ts no longer names apps/api/src/boot.ts");
  });

  it("T1: refuses a moved selection whose old literal survives only in a comment", () => {
    const dir = makeRepo(
      tree({
        "playwright.config.ts":
          "export default {\n" +
          '  // features: "tests/features/**/*.feature",\n' +
          '  features: "e2e/features/**/*.feature",\n' +
          '  steps: "tests/steps/**/*.ts",\n' +
          '  webServer: { command: "bun apps/api/src/boot.ts" },\n' +
          "};\n",
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain(
      "playwright.config.ts no longer names tests/features/**/*.feature in code",
    );
  });

  it("T1: refuses an unparsable config that still carries the three literals", () => {
    const dir = makeRepo(
      tree({
        "playwright.config.ts": `${PLAYWRIGHT_CONFIG_TEXT}]];\n`,
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain("playwright.config.ts does not parse");
  });
});

describe("#399 a walk that follows no edge is refused", () => {
  it("T1: refuses a policed workflow whose entries import nothing", () => {
    const dir = makeRepo(
      tree({
        "provision/vps/backup/restore-drill.mjs": DRILL_MJS.replace(
          'import { RECLAIM_SQL } from "./lib.mjs";\n',
          "",
        ),
        "provision/vps/backup/kajianq-backup.mjs": "export const backup = 1;\n",
        "provision/vps/backup/kajianq-restore.mjs": "export const restore = 1;\n",
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain("followed no import edge from its 4 entries (4 file(s) in all)");
  });

  it("refuses to call an empty entry set a closure", () => {
    expect(() => buildClosure([], REPO_ROOT)).toThrow(/no execution entries to walk/);
  });
});

describe("#399 green case — matched paths outside every deploy closure", () => {
  it("T3+T4: passes a tree where the class exists and only tests import it", () => {
    const dir = makeRepo(tree());
    const { status, stdout } = runCli(dir);
    expect(status).toBe(0);
    // Non-vacuous: the class really was matched, and the walk really walked.
    const evidence = /\((\d+) patterns, (\d+) matched paths\) × .*\((\d+) files\)/.exec(stdout);
    expect(evidence, stdout).not.toBeNull();
    expect(Number(evidence[1])).toBe(14);
    expect(Number(evidence[2])).toBeGreaterThan(3);
    expect(Number(evidence[3])).toBeGreaterThan(5);
    expect(stdout).toContain("0 matches");
  });

  it("passes a tree whose comment mentions a matched module (T3) — mentions are not imports", () => {
    const dir = makeRepo(
      tree({
        "apps/web/src/app.tsx":
          '/* import { renderApp } from "./components/app-test-utils"; */\n' +
          '// export * from "../components/app-test-utils";\n' +
          "export const App = () => null;\n",
      }),
    );
    expect(runCli(dir).status).toBe(0);
  });

  it("passes when an asset reference in index.html has no file behind it (a runtime URL)", () => {
    const dir = makeRepo(
      tree({
        "apps/web/index.html":
          '<script type="module" src="/src/main.tsx"></script>\n<img src="/generated-at-runtime.png" />\n',
      }),
    );
    const { status, stdout } = runCli(dir);
    expect(status).toBe(0);
    expect(stdout).toContain(
      "assets referenced but not files (runtime URLs, outside the graph): 1",
    );
  });

  it("passes the real repo, and its evidence is non-vacuous", () => {
    const { status, stdout, stderr } = runCli(REPO_ROOT);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    const evidence = /\((\d+) patterns, (\d+) matched paths\) × .*\((\d+) files\)/.exec(stdout);
    expect(evidence, stdout).not.toBeNull();
    expect(Number(evidence[1])).toBeGreaterThan(0);
    // A collapsed match set or closure would still print "0 matches" — these
    // floors are what make the pass mean something.
    expect(Number(evidence[2])).toBeGreaterThan(50);
    expect(Number(evidence[3])).toBeGreaterThan(100);
    // The drill's own walk covers its spawned scripts and migration, not just the
    // drill and its one import.
    const drill =
      /vps-restore-drill\.yml on\.push\.paths-ignore .*closure of (\d+) entries \((\d+) files\)/.exec(
        stdout,
      );
    expect(drill, stdout).not.toBeNull();
    expect(Number(drill[1])).toBe(4);
    expect(Number(drill[2])).toBeGreaterThan(4);
    expect(stdout).toContain("not policed, on purpose (no path filter): .github/workflows/ci.yml");
  });
});

describe("#399 fail-closed — unreadable input exits non-zero", () => {
  const workflowWith = (pushBody) => `name: Staging\non:\n  push:\n${pushBody}\n`;

  const cases = [
    {
      name: "a missing staging.yml",
      files: tree({}, [POLICED_WORKFLOW]),
      fragment: `${POLICED_WORKFLOW} not found`,
    },
    {
      name: "YAML that does not parse",
      files: tree({ [POLICED_WORKFLOW]: "name: Staging\non: [\n" }),
      fragment: "cannot parse the workflow YAML",
    },
    {
      name: "a workflow that is not a mapping",
      files: tree({ [POLICED_WORKFLOW]: "- name: Staging\n" }),
      fragment: "not a mapping",
    },
    {
      name: "no push trigger at all",
      files: tree({ [POLICED_WORKFLOW]: "name: Staging\non:\n  workflow_dispatch:\n" }),
      fragment: "no `on.push` trigger",
    },
    {
      name: "a push trigger without paths-ignore",
      files: tree({ [POLICED_WORKFLOW]: workflowWith("    branches: [main]") }),
      fragment: "`on.push.paths-ignore` is absent",
    },
    {
      name: "an inclusion filter on a policed workflow",
      files: tree({
        [POLICED_WORKFLOW]: workflowWith(
          '    paths:\n      - "src/**"\n    paths-ignore:\n      - "docs/**"',
        ),
      }),
      fragment: "carries a `paths` inclusion filter",
    },
    {
      name: "a scalar instead of a pattern list",
      files: tree({ [POLICED_WORKFLOW]: workflowWith('    paths-ignore: "docs/**"') }),
      fragment: "not a list",
    },
    {
      name: "an empty pattern list",
      files: tree({ [POLICED_WORKFLOW]: workflowWith("    paths-ignore: []") }),
      fragment: "is empty",
    },
    {
      name: "a negated pattern",
      files: tree({ [POLICED_WORKFLOW]: workflowWith('    paths-ignore:\n      - "!docs/**"') }),
      fragment: "negated pattern",
    },
    {
      name: "a glob the matcher does not model",
      files: tree({
        [POLICED_WORKFLOW]: workflowWith('    paths-ignore:\n      - "**/*.{ts,mjs}"'),
      }),
      fragment: "does not model",
    },
    {
      name: "a deploy entry file that vanished",
      files: tree({}, ["apps/api/src/cleanup.ts"]),
      fragment: "execution entry apps/api/src/cleanup.ts not found",
    },
    {
      name: "a deploy.sh with a fifth build entry",
      files: tree({
        "provision/vps/deploy/deploy.sh": `${DEPLOY_SH}bun build "apps/api/src/nightly.ts"\n`,
      }),
      fragment: "runs `bun build` 4 time(s)",
    },
    {
      name: "an import specifier that resolves to nothing",
      files: tree({
        "apps/api/src/app.ts": 'import { x } from "./does-not-exist";\nexport const x2 = x;\n',
      }),
      fragment: 'cannot resolve "./does-not-exist"',
    },
    {
      name: "a bare specifier that is neither workspace nor installed",
      files: tree({
        "apps/api/src/app.ts": 'import { x } from "ghost-package";\nexport const x2 = x;\n',
      }),
      fragment: 'cannot resolve bare specifier "ghost-package"',
    },
    {
      name: "a workspace export that points at no file",
      files: tree({
        "packages/kajianq-domain/package.json": `${JSON.stringify({
          name: "@app/kajianq-domain",
          exports: { ".": "./src/missing.ts" },
        })}\n`,
      }),
      fragment: "resolves to no file",
    },
  ];

  it.each(cases)("refuses $name", ({ files, fragment }) => {
    const { status, stderr } = runCli(makeRepo(files));
    expect(status).not.toBe(0);
    expect(stderr).toContain(fragment);
  });
});

describe("#399 the triggered workflows derive the class and pin their PR half", () => {
  it("derives the test class from the source's non-docs patterns", () => {
    expect(deriveTestClass([...DOCS, ...TEST_CLASS])).toEqual(TEST_CLASS);
  });

  it("passes the green tree and names every policed workflow in its evidence", () => {
    const { status, stdout, stderr } = runCli(makeRepo(tree()));
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain(".github/workflows/staging.yml on.push.paths-ignore");
    expect(stdout).toContain(".github/workflows/e2e.yml on.push.paths-ignore");
    expect(stdout).toContain(".github/workflows/vps-restore-drill.yml on.push.paths-ignore");
    expect(stdout).toContain("test class derived from .github/workflows/staging.yml: 8 patterns");
    expect(stdout).toContain("docs class pinned at 6 patterns");
    expect(stdout).toContain("pull_request filters carry the docs class only");
  });

  it("lists the workflows it does not police instead of hiding them", () => {
    const { stdout } = runCli(makeRepo(tree()));
    expect(stdout).toContain("not policed, on purpose (no path filter): .github/workflows/ci.yml");
  });

  it("refuses a push set that drops a class member", () => {
    const dir = makeRepo(
      tree({
        ".github/workflows/e2e.yml": workflowYaml("E2E", {
          pullRequest: DOCS,
          push: E2E_PUSH.filter((pattern) => pattern !== "vitest.config.ts"),
        }),
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain(
      "is not the pinned docs class plus the test class at .github/workflows/staging.yml",
    );
    expect(stderr).toContain('missing "vitest.config.ts"');
    expect(stderr).toContain("add it to this workflow's own list, the source already carries it");
  });

  it("refuses a push set that adds a pattern the class does not define", () => {
    const dir = makeRepo(
      tree({
        ".github/workflows/e2e.yml": workflowYaml("E2E", {
          pullRequest: DOCS,
          push: [...E2E_PUSH, "**/*.spec.ts"],
        }),
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain('unexpected "**/*.spec.ts"');
    expect(stderr).toContain(
      "remove it here, or add it at the source .github/workflows/staging.yml",
    );
  });

  it("refuses a kept input that is no longer in the execution closure", () => {
    const dir = makeRepo(tree({}, ["tests/features/chat.feature", "tests/steps/chat.steps.ts"]));
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain('keeps "tests/**" out of its push paths-ignore');
    expect(stderr).toContain("no file in its execution closure matches it");
  });

  it("refuses a policed workflow that vanished instead of skipping it", () => {
    const dir = makeRepo(tree({}, [".github/workflows/e2e.yml"]));
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain(".github/workflows/e2e.yml not found");
  });

  it("T1: dropping a docs pattern from the class source refuses too", () => {
    // The paid deploy re-widens here, and nothing else in the graph would notice:
    // the test class is derived from this list, so only the pinned docs half can.
    const dir = makeRepo(
      tree({
        [POLICED_WORKFLOW]: workflowYaml("Staging", {
          push: STAGING_PUSH.filter((pattern) => pattern !== "docs/**"),
        }),
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain('missing "docs/**"');
    expect(stderr).toContain("it is part of the pinned docs class");
  });

  it("pins the docs class to the real staging.yml's docs half", () => {
    const text = execFileSync("git", ["show", `HEAD:${POLICED_WORKFLOW}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    // Read the checked-in list textually: this test pins the source's docs half to
    // the constant, and a YAML parser is the CLI's runtime seam, not this test's.
    const docs = [...text.matchAll(/^\s+- "([^"]+)"$/gm)]
      .map((match) => match[1])
      .filter((pattern) => DOCS_ONLY_PATTERNS.includes(pattern));
    expect(docs).toEqual(DOCS_ONLY_PATTERNS);
  });

  it("T1: a fourth filtered workflow refuses instead of passing unseen", () => {
    const dir = makeRepo(
      tree({
        ".github/workflows/extra.yml": workflowYaml("Extra", { push: ["tests/**"] }),
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain(".github/workflows/extra.yml carries on.push.paths-ignore");
    expect(stderr).toContain("is not listed in WORKFLOW_SPECS");
  });

  it("T1: an unpoliced workflow with a paths inclusion filter refuses too", () => {
    // A paths-only workflow skips every push it does not include — the same
    // absent-run-reads-as-success class as paths-ignore, so it is refused rather
    // than printed as "not policed".
    const dir = makeRepo(
      tree({
        ".github/workflows/extra.yml": 'name: Extra\non:\n  push:\n    paths:\n      - "docs/**"\n',
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain(".github/workflows/extra.yml carries on.push.paths");
    expect(stderr).toContain("an inclusion filter this check does not police");
  });

  it("T1: a pull_request half on a workflow recorded as having none refuses", () => {
    const dir = makeRepo(
      tree({
        [POLICED_WORKFLOW]: workflowYaml("Staging", { push: TEST_CLASS, pullRequest: DOCS }),
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain(".github/workflows/staging.yml carries on.pull_request.paths-ignore");
    expect(stderr).toContain("WORKFLOW_SPECS records no pull_request half");
  });

  it("T1: an E2E step importing an ignored test-support helper exits non-zero", () => {
    const dir = makeRepo(
      tree({
        "tests/steps/chat.steps.ts":
          'import { createMemoryRagStore } from "@app/kajianq-domain/test-utils/memory-rag-store";\n' +
          "export const steps = createMemoryRagStore;\n",
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain(
      '"**/test-utils/**" matches packages/kajianq-domain/src/test-utils/memory-rag-store.ts',
    );
    expect(stderr).toContain(
      "reachable from execution entry tests/steps/chat.steps.ts: " +
        "tests/steps/chat.steps.ts → packages/kajianq-domain/src/test-utils/memory-rag-store.ts",
    );
  });

  it("T1: a drill entry importing an ignored helper exits non-zero", () => {
    const dir = makeRepo(
      tree({
        "provision/vps/backup/restore-drill.mjs": DRILL_MJS.replace(
          'import { RECLAIM_SQL } from "./lib.mjs";',
          'import { RECLAIM_SQL } from "./lib.mjs";\nimport { helper } from "../../../test-utils/helper";',
        ),
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain('"**/test-utils/**" matches test-utils/helper.ts');
    expect(stderr).toContain("provision/vps/backup/restore-drill.mjs → test-utils/helper.ts");
  });

  it("refuses a pull_request filter wider than the docs class", () => {
    const dir = makeRepo(
      tree({
        ".github/workflows/e2e.yml": workflowYaml("E2E", {
          pullRequest: [...DOCS, "**/*.test.ts"],
          push: E2E_PUSH,
        }),
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain(
      ".github/workflows/e2e.yml's on.pull_request.paths-ignore is not the docs class",
    );
    expect(stderr).toContain('it adds "**/*.test.ts"');
    expect(stderr).toContain("never reports on a pull request at all");
  });

  it("refuses a pull_request filter that drops a docs pattern", () => {
    const dir = makeRepo(
      tree({
        ".github/workflows/vps-restore-drill.yml": workflowYaml("VPS restore drill", {
          pullRequest: DOCS.slice(1),
          push: DRILL_PUSH,
        }),
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain('it drops "**.md"');
  });

  it("refuses a PR-triggered workflow that removes its pull_request trigger", () => {
    const dir = makeRepo(
      tree({
        ".github/workflows/e2e.yml": workflowYaml("E2E", { push: E2E_PUSH }),
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain("no `on.pull_request` trigger");
  });
});
