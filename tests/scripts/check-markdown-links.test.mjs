import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ADR_ID_RE,
  CLAIM_ROOTS,
  KNOWN_RETIRED,
  ROOTS,
  adjudicate,
  adrIdResolves,
  analyse,
  buildContext,
  ignoredTargets,
  inlineCodeSpans,
  isPathClaim,
  isRecord,
  isSkillName,
  makeTree,
  prose,
  resolveClaim,
  skillMentionAt,
  toRepoPath,
  walk,
} from "../../scripts/check-markdown-links.mjs";

const SCRIPT = resolve(process.cwd(), "scripts/check-markdown-links.mjs");
const CLI = SCRIPT;
const FAKE_ROOT = "/repo";

/**
 * Every pure case builds a synthetic tree and never touches the filesystem —
 * the classifier, the resolver and the adjudicator are the contract, and the
 * CLI fixtures at the bottom prove the wiring end to end.
 */
function ctxOf({ paths = [], adr = [], skills = [], root = FAKE_ROOT } = {}) {
  return { root, tree: makeTree(paths), adrNames: adr, skillDirs: new Set(skills) };
}

function scan(text, options = {}) {
  const { relPath = "docs/living.md", allowlist = [], ignored, files, ...treeOptions } = options;
  const ctx = ctxOf(treeOptions);
  const findings = analyse([{ relPath, text }], ctx);
  return adjudicate(findings, { allowlist, ignored, files });
}

function targets(result) {
  return result.violations.map((v) => v.target);
}

describe("markdown-links — scope rules (#368)", () => {
  const tree = makeTree(["AGENTS.md", "package.json", "docs/a.md", "apps/web/index.html"]);

  it("claims a repo-relative path under a tracked root", () => {
    expect(isPathClaim("packages/rag-core/src/run.ts", tree)).toBe(true);
    expect(isPathClaim("docs/ARCHITECTURE.md", tree)).toBe(true);
    expect(isPathClaim(".agents/skills/manager/SKILL.md", tree)).toBe(true);
    // A directory reference keeps its trailing slash in prose, and is a claim.
    expect(isPathClaim("provision/vps/", tree)).toBe(true);
  });

  it("claims a bare token only when it is a tracked root-level file", () => {
    expect(isPathClaim("AGENTS.md", tree)).toBe(true);
    expect(isPathClaim("package.json", tree)).toBe(true);
    // COST, stated in the header: a bare prose filename that lives in a
    // subdirectory is not a claim — 300+ such tokens are version strings,
    // member expressions and model ids, so a wider rule is a false-positive
    // factory.
    expect(isPathClaim("notes.md", tree)).toBe(false);
    expect(isPathClaim("models.json", tree)).toBe(false);
    expect(isPathClaim("4.0.0-rc.113", tree)).toBe(false);
    expect(isPathClaim("Effect.runPromise", tree)).toBe(false);
  });

  it("leaves `~`-rooted host paths, commands, URLs, globs and placeholders alone", () => {
    for (const target of [
      "~/.dsh/settings.yaml",
      "bun run lint",
      "git stash",
      "https://github.com/ahaqqu/KajianQ/issues/368",
      "mailto:owner@example.com",
      "#anchor",
      "//cdn.example.com/x",
      "**/*.ts",
      "apps/**/*.ts",
      "<slug>",
      "<role>",
      "<label>",
      "/etc/hosts",
    ]) {
      expect(isPathClaim(target, tree), target).toBe(false);
    }
  });

  it("treats an elided label as a display label, not a path (class D)", () => {
    expect(isPathClaim("adr/0037-…", tree)).toBe(false);
    expect(isPathClaim("adr/0043-...", tree)).toBe(false);
  });

  it("never reads a code span inside a fenced block", () => {
    const text = ["# Doc", "```ts", "import x from 'apps/foo.ts';", "```", "after"].join("\n");
    expect(prose(text)[2]).toBe("");
    expect(scan(text, { paths: [] }).violations).toEqual([]);
  });

  it("does not flag a prose line that merely mentions a path", () => {
    const text = "See docs/ARCHITECTURE.md and packages/rag-core/src/run.ts for the detail.";
    expect(scan(text).violations).toEqual([]);
  });

  it("extracts every inline span on a line with the index it starts at", () => {
    const spans = inlineCodeSpans("run `bun run lint` then `docs/a.md`");
    expect(spans.map((s) => s.target)).toEqual(["bun run lint", "docs/a.md"]);
    expect(spans[1].index).toBe("run `bun run lint` then ".length);
  });
});

describe("markdown-links — resolution base", () => {
  it("resolves a root-relative claim against the repo root", () => {
    const ctx = ctxOf({ paths: ["scripts/check-boundary.mjs"] });
    expect(resolveClaim("scripts/check-boundary.mjs", "docs", ctx)).toBe("tracked");
  });

  it("resolves a package-relative claim against the containing file", () => {
    // packages/infra/README.md writes `scripts/db-migrate.mjs` meaning
    // packages/infra/scripts/db-migrate.mjs. A root-only rule invents a
    // false positive here.
    const result = scan("Run `scripts/db-migrate.mjs` to migrate.", {
      relPath: "packages/infra/README.md",
      paths: ["packages/infra/scripts/db-migrate.mjs"],
    });
    expect(result.violations).toEqual([]);
    expect(result.counters.claims).toBe(1);
  });

  it("flags a target that neither base finds", () => {
    const result = scan("Run `scripts/gone.mjs` to migrate.", {
      relPath: "packages/infra/README.md",
      paths: ["packages/infra/scripts/db-migrate.mjs"],
    });
    expect(targets(result)).toEqual(["scripts/gone.mjs"]);
  });

  it("gives Markdown links the file-only base a renderer uses", () => {
    // TRAP: the root fallback must not leak into the link half. GitHub
    // resolves [x](scripts/a.mjs) against docs/, where nothing exists.
    const result = scan("See [the gate](scripts/check-boundary.mjs).", {
      relPath: "docs/living.md",
      paths: ["scripts/check-boundary.mjs"],
    });
    expect(targets(result)).toEqual(["scripts/check-boundary.mjs"]);
    expect(result.violations[0].reason).toBe("target does not exist");
  });

  it("still accepts a link written beside its target", () => {
    const result = scan("See [the gate](check-boundary.mjs).", {
      relPath: "docs/living.md",
      paths: ["docs/check-boundary.mjs"],
    });
    expect(result.violations).toEqual([]);
  });

  it("keeps the root-absolute link verdict", () => {
    const result = scan("See [x](/docs/a.md).", {
      relPath: "docs/living.md",
      paths: ["docs/a.md"],
    });
    expect(result.violations[0].reason).toBe(
      "root-absolute path (resolve it relative to the file instead)",
    );
  });

  it("refuses a target that escapes the repository", () => {
    expect(toRepoPath(FAKE_ROOT, "docs", "../../etc/hosts")).toBeNull();
  });
});

describe("markdown-links — the committed tree, not the working tree", () => {
  it("flags a path that exists only as an untracked build output", () => {
    // The gate resolves the commit, so the verdict cannot depend on whether
    // the caller just ran `bun run build:web`. apps/web/dist/index.html is
    // absent from the index and is caught.
    const result = scan("The deploy needs `apps/web/dist/index.html`.", { paths: ["docs/a.md"] });
    expect(targets(result)).toEqual(["apps/web/dist/index.html"]);
  });

  it("skips a target git ignores, and counts it", () => {
    const ignored = new Set(["apps/web/dist/index.html"]);
    const result = scan("The deploy needs `apps/web/dist/index.html`.", {
      paths: ["docs/a.md"],
      ignored,
    });
    expect(result.violations).toEqual([]);
    expect(result.counters.ignored).toBe(1);
  });
});

describe("markdown-links — class A: ADR cited by number", () => {
  it("resolves adr/NNNN against adr/NNNN-*.md", () => {
    const adr = ["0045-surah-reference-scoped-expansion.md", "0044-vps-serving-path-cutover.md"];
    expect(adrIdResolves("adr/0045", adr)).toBe(true);
    expect(scan("Recorded in `adr/0045`.", { paths: [], adr }).violations).toEqual([]);
  });

  it("flags an ADR number nothing matches", () => {
    const adr = ["0045-surah-reference-scoped-expansion.md"];
    expect(targets(scan("Recorded in `adr/9999`.", { paths: [], adr }))).toEqual(["adr/9999"]);
  });

  it("requires four digits, so a truncated or padded id is a typo", () => {
    const adr = ["0045-surah-reference-scoped-expansion.md"];
    expect(ADR_ID_RE.test("adr/004")).toBe(false);
    expect(ADR_ID_RE.test("adr/00455")).toBe(false);
    expect(targets(scan("See `adr/004`.", { paths: [], adr }))).toEqual(["adr/004"]);
  });

  it("accepts a duplicated number — the spec row is right, the tree is wrong", () => {
    // adr/0005 is currently carried by two files (0005-monorepo-…,
    // 0005-role-model-pins-…). The gate cannot police numbering, and the
    // spec's §8 row label is a correct reference; follow-up filed.
    const adr = [
      "0005-monorepo-engine-plus-product.md",
      "0005-role-model-pins-honored-per-harness.md",
    ];
    expect(adrIdResolves("adr/0005", adr)).toBe(true);
  });

  it("reports every adr/NNNN as dangling when adr/ is gone", () => {
    expect(targets(scan("See `adr/0045`.", { paths: [], adr: [] }))).toEqual(["adr/0045"]);
  });
});

describe("markdown-links — class B: records of a moment", () => {
  it("does not enforce code-span paths inside adr/", () => {
    const result = scan("Retires `scripts/template-sync/` and `docs/QUOTA.md`.", {
      relPath: "adr/0030-retire-template-sync.md",
      paths: [],
    });
    expect(result.violations).toEqual([]);
    expect(result.counters.recordsDead).toBe(2);
  });

  it("does not enforce them inside the executed cutover record either", () => {
    const result = scan("`docs/VPS-CUTOVER-RUNBOOK.md` has been retired.", {
      relPath: "docs/VPS-CUTOVER-RECORD.md",
      paths: [],
    });
    expect(result.violations).toEqual([]);
    expect(result.counters.recordsDead).toBe(1);
  });

  it("still enforces the Markdown-link half inside a record", () => {
    // The exemption is scoped to code-span claims: a record whose link rots
    // is still red, and is still fixable without editing the record's argument.
    const result = scan("See [the runbook](./VPS-CUTOVER-RUNBOOK.md).", {
      relPath: "adr/0030-retire-template-sync.md",
      paths: [],
    });
    expect(targets(result)).toEqual(["./VPS-CUTOVER-RUNBOOK.md"]);
  });

  it("recognises exactly the two record shapes", () => {
    expect(isRecord("adr/0030-retire-template-sync.md")).toBe(true);
    expect(isRecord("docs/VPS-CUTOVER-RECORD.md")).toBe(true);
    expect(isRecord("docs/ARCHITECTURE.md")).toBe(false);
    expect(isRecord("SPECS.md")).toBe(false);
    // A lookalike directory is not the record tree.
    expect(isRecord("adr-notes/x.md")).toBe(false);
  });

  it("enforces code-span paths in every other file, including INITIAL_IDEA.md", () => {
    const result = scan("Dropped `packages/local-first`.", {
      relPath: "INITIAL_IDEA.md",
      paths: [],
    });
    expect(targets(result)).toEqual(["packages/local-first"]);
  });
});

describe("markdown-links — class C: the allowlist is tiny and self-pruning", () => {
  const entry = {
    file: "SPECS.md",
    target: "packages/local-first",
    reason: "a reason long enough",
  };

  it("silences the exact (file, target) pair it names", () => {
    const result = scan("**Dropped from template:** `packages/local-first`.", {
      relPath: "SPECS.md",
      paths: [],
      allowlist: [entry],
    });
    expect(result.violations).toEqual([]);
    expect(result.counters.allowlisted).toBe(1);
  });

  it("does not silence the same target in another file", () => {
    const result = scan("`packages/local-first`.", {
      relPath: "docs/ARCHITECTURE.md",
      paths: [],
      allowlist: [entry],
    });
    expect(result.counters.allowlisted).toBe(0);
    expect(
      result.violations.some((v) => v.kind === "path" && v.target === "packages/local-first"),
    ).toBe(true);
  });

  it("does not evaluate an entry whose file is not in the scanned corpus", () => {
    // A fixture checkout has no SPECS.md, so the entry cannot be judged stale
    // there; against the real corpus it is, which is what keeps the list honest.
    const result = scan("Nothing dead here.", {
      relPath: "docs/living.md",
      paths: [],
      allowlist: [entry],
      files: new Set(["docs/living.md"]),
    });
    expect(result.violations).toEqual([]);
  });

  it("fails when an entry matches nothing — the list cannot rot", () => {
    const result = scan("Nothing dead here.", {
      relPath: "SPECS.md",
      paths: [],
      allowlist: [entry],
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].kind).toBe("stale-allowlist");
    expect(result.violations[0].reason).toContain("stale allowlist entry");
  });

  it("keeps the shipped allowlist small, reasoned, unique and outside records", () => {
    expect(KNOWN_RETIRED.length).toBeGreaterThan(0);
    expect(KNOWN_RETIRED.length).toBeLessThanOrEqual(4);
    const keys = KNOWN_RETIRED.map((e) => `${e.file}\u0000${e.target}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of KNOWN_RETIRED) {
      expect(e.reason.length).toBeGreaterThan(20);
      expect(isRecord(e.file)).toBe(false);
    }
  });
});

describe("markdown-links — the skill-name half", () => {
  it("flags a bare skill name the marker claims but .agents/skills/ does not have", () => {
    const result = scan("invoke the `agentic-workflow` skill", {
      relPath: "AGENTS.md",
      paths: [],
      skills: ["code-review", "manager"],
    });
    expect(targets(result)).toEqual(["agentic-workflow"]);
    expect(result.violations[0].reason).toBe(
      "skill name: no .agents/skills/agentic-workflow/SKILL.md",
    );
  });

  it("accepts a skill name that names a directory with a SKILL.md", () => {
    const result = scan("Apply the `code-review` skill end-to-end.", {
      relPath: "AGENTS.md",
      paths: [],
      skills: ["code-review"],
    });
    expect(result.violations).toEqual([]);
    expect(result.counters.skills).toBe(1);
  });

  it("matches both marker orders, and the plural and possessive", () => {
    const line = "see skill `manager` and the `qa-phase` skill's table";
    expect(skillMentionAt(line, "manager", line.indexOf("`manager`"))).toBe(true);
    expect(skillMentionAt(line, "qa-phase", line.indexOf("`qa-phase`"))).toBe(true);
    expect(skillMentionAt("the `manager` skills list", "manager", 4)).toBe(true);
  });

  it("does not fire on a bare name with no skill marker", () => {
    expect(isSkillName("code-review")).toBe(true);
    expect(scan("Run `code-review`.", { paths: [], skills: [] }).violations).toEqual([]);
  });

  it("does not treat SKILL.md or a path as a skill name", () => {
    expect(isSkillName("SKILL.md")).toBe(false);
    expect(isSkillName(".agents/skills/manager")).toBe(false);
  });

  it('does NOT extend to "the `X` role" — that marker has no resolution target', () => {
    // 21 unresolved role names (cheap, embedder, generator, decision-candidates,
    // kajianq) make this a false-positive factory; the ticket rejects it.
    const result = scan("The `cheap` role does the work.", { paths: [], skills: [] });
    expect(result.violations).toEqual([]);
  });

  it("reproduces #367's two dead references from one line", () => {
    const text = "invoke the `agentic-workflow` skill (`.agents/skills/agentic-workflow/SKILL.md`)";
    const findings = analyse([{ relPath: "AGENTS.md", text }], ctxOf({ paths: [], skills: [] }));
    const { violations } = adjudicate(findings, { allowlist: [] });
    expect(violations.map((v) => v.kind).sort()).toEqual(["path", "skill"]);
    expect(violations.map((v) => v.target).sort()).toEqual([
      ".agents/skills/agentic-workflow/SKILL.md",
      "agentic-workflow",
    ]);
  });
});

describe("markdown-links — the real tree", () => {
  /** The real corpus, read the same way the CLI reads it. */
  function realScan() {
    const ctx = buildContext(process.cwd());
    const files = ROOTS.map((r) => join(process.cwd(), r))
      .filter((p) => existsSync(p))
      .flatMap((p) => walk(p));
    const sources = files.map((file) => ({
      relPath: file.slice(process.cwd().length + 1),
      text: readFileSync(file, "utf8"),
    }));
    const findings = analyse(sources, ctx);
    const dead = findings.filter((f) => f.kind === "path" && f.status === "missing");
    return {
      files,
      result: adjudicate(findings, {
        files: new Set(sources.map((s) => s.relPath)),
        ignored: ignoredTargets(
          process.cwd(),
          dead.map((f) => f.target),
        ),
      }),
    };
  }

  it("is green on the repository as it stands, with the narrowing visible", () => {
    const out = execFileSync("bun", [CLI], { encoding: "utf8" });
    expect(out).toContain("markdown-links: OK");
    // The blind spots this change accepted must be printed on every green run.
    expect(out).toMatch(/\d+ known-retired allowlisted/);
    expect(out).toMatch(/\d+ dead claims inside record files unchecked/);
  });

  it("uses every shipped allowlist entry — none is stale against the real corpus", () => {
    const { result } = realScan();
    expect(result.violations).toEqual([]);
    expect(result.counters.allowlisted).toBe(KNOWN_RETIRED.length);
  });

  it("resolves a real package-relative claim end to end", () => {
    // packages/infra/README.md:109 — `scripts/db-migrate.mjs`.
    const ctx = buildContext(process.cwd());
    expect(resolveClaim("scripts/db-migrate.mjs", "packages/infra", ctx)).toBe("tracked");
  });

  it("knows which real targets git ignores", () => {
    const ignored = ignoredTargets(process.cwd(), [
      "apps/web/dist/index.html",
      "docs/ARCHITECTURE.md",
    ]);
    expect(ignored.has("apps/web/dist/index.html")).toBe(true);
    expect(ignored.has("docs/ARCHITECTURE.md")).toBe(false);
  });

  it("covers every tracked top-level directory — the scope cannot shrink silently", () => {
    // CLAIM_ROOTS is the stated scope rule. A new top-level directory that does
    // not join it stops being a claim root, and this is what says so.
    const ctx = buildContext(process.cwd());
    const topDirs = [...ctx.tree.dirs].filter((d) => !d.includes("/"));
    expect(topDirs.filter((d) => !CLAIM_ROOTS.includes(d))).toEqual([]);
    // And the roots the ticket names are all still there.
    for (const root of ["apps", "packages", "scripts", "docs", "adr", ".agents", ".zcode"]) {
      expect(topDirs).toContain(root);
    }
  });
});

/**
 * CLI fixtures: a throwaway git repo under mkdtemp, with a copy of the gate at
 * `<fixture>/scripts/` so it resolves its own root from `import.meta.dir`. The
 * index is the resolution base, so the fixture must be `git add`ed — that is
 * the rule under test, not incidental setup.
 */
function fixtureRepo(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "md-links-")));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, "scripts", "check-markdown-links.mjs"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function runFixture(dir) {
  return spawnSync("bun", ["scripts/check-markdown-links.mjs"], { cwd: dir, encoding: "utf8" });
}

describe("markdown-links — CLI fixtures", () => {
  it("reddens on #367's shape: a dead code-span path and a dead skill name", () => {
    const dir = fixtureRepo({
      ".gitignore": "dist/\n",
      "docs/living.md": [
        "# Living doc",
        "",
        "Replaced in #133: the `agentic-workflow` skill",
        "(`.agents/skills/agentic-workflow/SKILL.md`).",
        "",
        "```md",
        "This example is inert: `packages/gone.ts` and the `no-such-skill` skill.",
        "```",
      ].join("\n"),
    });
    const run = runFixture(dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("2 dangling reference(s)");
    expect(run.stderr).toContain("docs/living.md:3 -> agentic-workflow");
    expect(run.stderr).toContain("docs/living.md:4 -> .agents/skills/agentic-workflow/SKILL.md");
    // The fenced copy of the same shapes is an example, never a citation.
    expect(run.stderr).not.toContain("packages/gone.ts");
    expect(run.stderr).not.toContain("no-such-skill");
    rmSync(dir, { recursive: true, force: true });
  });

  it("is green on a fixture that exercises every rule at once", () => {
    const dir = fixtureRepo({
      ".gitignore": "dist/\n",
      "adr/0045-surah-reference-scoped-expansion.md": "# ADR-0045\n",
      ".agents/skills/code-review/SKILL.md": "# code-review\n",
      "packages/infra/scripts/db-migrate.mjs": "// migrate\n",
      "packages/infra/README.md": "Run `scripts/db-migrate.mjs` to migrate.\n",
      "docs/living.md": [
        "# Living doc",
        "",
        "Recorded in `adr/0045`, applied by the `code-review` skill. The deploy",
        "needs `apps/web/dist/index.html`. A prose line mentioning",
        "packages/local-first is not a claim.",
      ].join("\n"),
    });
    const run = runFixture(dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("markdown-links: OK");
    // 2 path claims + 1 gitignored build path + 1 skill name.
    expect(run.stdout).toContain("3 code-span path claims + 1 skill names");
    expect(run.stdout).toContain("1 gitignored build paths skipped");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reddens on an ignored build path only by policy, never by presence on disk", () => {
    const dir = fixtureRepo({
      ".gitignore": "docs/untracked.md\n",
      "docs/living.md": "See `docs/untracked.md`.\n",
    });
    // Real on disk, absent from the index: ignored, so skipped.
    writeFileSync(join(dir, "docs", "untracked.md"), "# notes\n");
    const ignoredRun = runFixture(dir);
    expect(ignoredRun.status).toBe(0);
    expect(ignoredRun.stdout).toContain("1 gitignored build paths skipped");

    // Stop ignoring it, keep it untracked: now the gate must refuse it, even
    // though the file is right there on disk.
    writeFileSync(join(dir, ".gitignore"), "# nothing ignored\n");
    const untrackedRun = runFixture(dir);
    expect(untrackedRun.status).toBe(1);
    expect(untrackedRun.stderr).toContain("docs/living.md:1 -> docs/untracked.md");
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails loudly when the checkout has no git index", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "md-links-nogit-")));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    copyFileSync(SCRIPT, join(dir, "scripts", "check-markdown-links.mjs"));
    writeFileSync(join(dir, "SPECS.md"), "# spec\n");
    const run = spawnSync("bun", ["scripts/check-markdown-links.mjs"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("not a git checkout");
    rmSync(dir, { recursive: true, force: true });
  });
});
