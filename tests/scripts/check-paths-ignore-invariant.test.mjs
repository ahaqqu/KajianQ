import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FILE_ENTRIES,
  InvariantRefusal,
  POLICED_WORKFLOW,
  REPO_ROOT,
  WEB_ENTRY,
  assertDeployEntrySet,
  buildClosure,
  collectRepoFiles,
  compilePattern,
  compilePatterns,
  deployEntries,
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
 * #399 — the gate for staging.yml's paths-ignore invariant.
 *
 * The traps this suite is built around, named before the assertions:
 *   T1 (falsification)  a matched path that IS imported by a deploy entry must
 *                       exit non-zero — a suite that only ever passes the clean
 *                       tree tests nothing;
 *   T2 (rename)         the production module is moved into the class by a NAME
 *                       change (`prod-test-utils.ts`), so any check built from a
 *                       name list would pass it — the closure must catch it;
 *   T3 (comment)        a file containing the text of an import of a matched
 *                       module, inside a comment, must stay green — that is the
 *                       difference between "imports" and "mentions";
 *   T4 (importer class) a matched helper imported only by `*.test.ts` files must
 *                       stay green: the class exists to be imported by tests;
 *   T5 (glob)           `*` must never cross `/`, `**` must, and `**` before a
 *                       slash must match zero directories;
 *   T6 (fail-closed)    unreadable input refuses non-zero, never passes.
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

const WORKFLOW = `name: Staging
on:
  push:
    branches: [main]
    paths-ignore:
      - "tests/**"
      - "**/*.test.ts"
      - "**/test-utils/**"
      - "**/*test-utils*"
      - "**/test-fixtures*"
      - "vitest.config.ts"
  workflow_dispatch:
`;

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
 * The green tree: every class member exists, and none of them is imported by a
 * deploy entry. `app.test.ts` imports the domain pack's test-utils (T4), and
 * `app.tsx` carries an import statement inside a comment (T3).
 */
const BASE = {
  ".github/workflows/staging.yml": WORKFLOW,
  "provision/vps/deploy/deploy.sh": DEPLOY_SH,
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
  "provision/vps/backup/kajianq-backup.mjs": 'import { lib } from "./lib.mjs";\nlib();\n',
  "provision/vps/backup/lib.mjs": "export const lib = () => {};\n",
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

/** The JSON subset `parsePathsIgnore` accepts as an injected parser. */
const jsonParser = (text) => JSON.parse(text);

describe("#399 GitHub glob semantics, not the shell's", () => {
  const cases = [
    // T5 — the two wildcards, and the zero-directory `**` case.
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
    // The class members #380/#398 rely on, matched by the real patterns.
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

  it("refuses paths together with paths-ignore (a combination GitHub rejects)", () => {
    expect(() =>
      parsePathsIgnore(
        JSON.stringify({ on: { push: { paths: ["src/**"], "paths-ignore": ["docs/**"] } } }),
        jsonParser,
      ),
    ).toThrow(/both `paths` and `paths-ignore`/);
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
    ]);
    expect(specs.every((edge) => edge.kind === "module")).toBe(true);
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

describe("#399 green case — matched paths outside every deploy closure", () => {
  it("T3+T4: passes a tree where the class exists and only tests import it", () => {
    const dir = makeRepo(tree());
    const { status, stdout } = runCli(dir);
    expect(status).toBe(0);
    // Non-vacuous: the class really was matched, and the walk really walked.
    const evidence = /\((\d+) patterns, (\d+) matched paths\) × .*\((\d+) files\)/.exec(stdout);
    expect(evidence, stdout).not.toBeNull();
    expect(Number(evidence[1])).toBe(6);
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
      name: "paths together with paths-ignore",
      files: tree({
        [POLICED_WORKFLOW]: workflowWith(
          '    paths:\n      - "src/**"\n    paths-ignore:\n      - "docs/**"',
        ),
      }),
      fragment: "both `paths` and `paths-ignore`",
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
      fragment: "deploy entry apps/api/src/cleanup.ts not found",
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

describe("#399 unpoliced workflows stay docs-only (#379)", () => {
  it("passes when the other triggered workflows ignore only docs patterns", () => {
    const dir = makeRepo(
      tree({
        ".github/workflows/e2e.yml":
          "name: E2E\non:\n  push:\n    branches: [main]\n    paths-ignore:\n" +
          '      - "**.md"\n      - "docs/**"\n',
      }),
    );
    expect(runCli(dir).status).toBe(0);
  });

  it("refuses when an unpoliced workflow grows a class this check does not vouch for", () => {
    const dir = makeRepo(
      tree({
        ".github/workflows/e2e.yml":
          "name: E2E\non:\n  push:\n    branches: [main]\n    paths-ignore:\n" +
          '      - "docs/**"\n      - "**/test-utils/**"\n',
      }),
    );
    const { status, stderr } = runCli(dir);
    expect(status).not.toBe(0);
    expect(stderr).toContain("carries a non-docs paths-ignore class (**/test-utils/**)");
    expect(stderr).toContain("Add its trigger set to POLICED_WORKFLOWS");
  });

  it("names what it does not police in its own output", () => {
    const { stdout } = runCli(REPO_ROOT);
    expect(stdout).toContain("not policed, on purpose: .github/workflows/e2e.yml");
    expect(stdout).toContain(".github/workflows/vps-restore-drill.yml");
  });
});
