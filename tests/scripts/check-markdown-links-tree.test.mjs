// The docs:links gate against the real repository and through its CLI: the
// committed-tree rule, the allowlist's self-pruning, and what the entry point
// prints. The CLI fixtures copy the gate's modules into a throwaway git repo.
import { describe, expect, it } from "vite-plus/test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CLAIM_ROOTS,
  KNOWN_RETIRED,
  RECORD_DIRS,
  RECORD_FILES,
  isRecord,
} from "../../scripts/markdown-links/policy.mjs";
import {
  ROOT,
  adjudicate,
  analyse,
  buildContext,
  formatOkLine,
  ignoredTargets,
  isSkillName,
  judgeClaim,
  loadCorpus,
  runGate,
  skillMentionAt,
} from "../../scripts/check-markdown-links.mjs";
import { CLI, SCRIPT, scan } from "./check-markdown-links-fixture.mjs";

describe("markdown-links — the real tree", () => {
  it("is green on the repository as it stands, with the narrowing visible", () => {
    const out = execFileSync("bun", [CLI], { encoding: "utf8" });
    expect(out).toContain("markdown-links: OK");
    // The gate's blind spots are printed on every green run.
    expect(out).toMatch(/\d+ known-retired allowlisted/);
    expect(out).toMatch(/\d+ dead claims inside record files unchecked/);
  });

  it("prints exactly what `runGate` decided — one driver, not two", () => {
    // The CLI must print the same counters the tests assert on, so the suite
    // cannot pass against wiring the CLI no longer has.
    const run = runGate(ROOT);
    const corpus = loadCorpus(ROOT);
    const out = execFileSync("bun", [CLI], { encoding: "utf8" }).trim();
    expect(run.violations).toEqual([]);
    // The corpus loader is the CLI's, not a second implementation of it.
    expect(corpus.files.length).toBe(run.files.length);
    expect(corpus.sources.some((s) => s.relPath === "SPECS.md")).toBe(true);
    expect(out).toBe(formatOkLine(run.counters, run.files.length));
  });

  it("closes the OK line's arithmetic: checked = resolved + allowlisted + ignored", () => {
    // "Resolve" counts only what was proved: the allowlisted and the gitignored
    // are checked and *not* resolved, and this invariant keeps the line honest.
    const { counters } = runGate(ROOT);
    const checked = counters.links + counters.claims + counters.skills;
    expect(checked).toBe(counters.resolved + counters.allowlisted + counters.ignored);
    expect(counters.resolved).toBeLessThan(checked);
  });

  it("uses every shipped allowlist entry — none is stale against the real corpus", () => {
    const { violations, counters } = runGate(ROOT);
    expect(violations).toEqual([]);
    expect(counters.allowlisted).toBe(KNOWN_RETIRED.length);
  });

  it("resolves a real package-relative claim end to end", () => {
    // The package-relative control: `scripts/db-migrate.mjs` in packages/infra/README.md.
    const ctx = buildContext(ROOT);
    expect(judgeClaim("scripts/db-migrate.mjs", "packages/infra", ctx).status).toBe("ok");
  });

  it("resolves the `..` variant of that same control end to end (#391)", () => {
    // The same control written with the `../` idiom from `docs/`: it must also resolve.
    const ctx = buildContext(ROOT);
    const findings = analyse(
      [
        {
          relPath: "docs/ARCHITECTURE.md",
          text: "Run `../packages/infra/scripts/db-migrate.mjs` to migrate.",
        },
      ],
      ctx,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("ok");
    expect(findings[0].repoPath).toBe("packages/infra/scripts/db-migrate.mjs");
    const { violations, counters } = adjudicate(findings, { allowlist: [] });
    expect(violations).toEqual([]);
    expect(counters.claims).toBe(1);
    expect(counters.resolved).toBe(1);
  });

  it("knows which real targets git ignores", () => {
    const ignored = ignoredTargets(ROOT, ["apps/web/dist/index.html", "docs/ARCHITECTURE.md"]);
    expect(ignored.has("apps/web/dist/index.html")).toBe(true);
    expect(ignored.has("docs/ARCHITECTURE.md")).toBe(false);
  });

  it("keeps the two `./`-rooted literals exact and out of the claim set (#396)", () => {
    // Both live sites quote the asset handler's inline default — a *value* the
    // operator must read, never a reference to a path here — and render it as a
    // fenced literal, so no exemption entry is needed; un-fencing one re-claims it.
    const ctx = buildContext(ROOT);
    for (const relPath of ["docs/VPS-SETUP.md", "docs/VPS-OPERATIONS.md"]) {
      const text = readFileSync(join(ROOT, relPath), "utf8");
      expect(text, relPath).toContain("./apps/web/dist");
      const spanClaims = analyse([{ relPath, text }], ctx).filter(
        (f) => f.kind === "path" && f.target.startsWith("./"),
      );
      expect(spanClaims, relPath).toEqual([]);
    }
    // ...and the literal the docs quote is the code's own default, so the two cannot drift.
    expect(readFileSync(join(ROOT, "apps/api/src/lib/server.ts"), "utf8")).toContain(
      'env.KAJIANQ_WEB_ROOT ?? "./apps/web/dist"',
    );
  });

  it("covers every tracked top-level directory — the scope cannot shrink silently", () => {
    // CLAIM_ROOTS is the stated scope rule: a new top-level directory must join it.
    const ctx = buildContext(ROOT);
    const topDirs = [...ctx.tree.dirs].filter((d) => !d.includes("/"));
    expect(topDirs.filter((d) => !CLAIM_ROOTS.includes(d))).toEqual([]);
    for (const root of ["apps", "packages", "scripts", "docs", "adr", ".agents", ".zcode"]) {
      expect(topDirs).toContain(root);
    }
  });

  it("keeps record membership to real, tracked records", () => {
    // A record is an executed log or a decision record, never a living how-to, so
    // every member must be a real tracked path — a typo cannot widen the exemption.
    const { tree } = buildContext(ROOT);
    for (const dir of RECORD_DIRS) expect(tree.dirs.has(dir), dir).toBe(true);
    for (const file of RECORD_FILES) expect(tree.files.has(file), file).toBe(true);
    // A record's own ADRs are records; a living doc is not.
    expect(isRecord("adr/0044-vps-serving-path-cutover.md")).toBe(true);
    expect(RECORD_DIRS.some((d) => isRecord(`${d}/x.md`))).toBe(true);
    for (const living of ["AGENTS.md", "SPECS.md", "docs/ARCHITECTURE.md"]) {
      expect(isRecord(living), living).toBe(false);
    }
  });

  it("distinguishes the two deliberately unchecked role markers", () => {
    // The "the `X` role" marker covers two namespaces — live harness roles
    // (`.zcode/agents/<role>.md`) and model-stage names — and is deliberately unchecked.
    const { tree } = buildContext(ROOT);
    for (const role of ["qa", "reviewer", "fixer"]) {
      expect(tree.files.has(`.zcode/agents/${role}.md`), role).toBe(true);
    }
    expect(tree.files.has(".zcode/agents/test-implementer.md")).toBe(false);
    expect(isSkillName("qa")).toBe(true);
    expect(scan("The `qa` role owns the probes.", { paths: [], skills: [] }).violations).toEqual(
      [],
    );
    // ...and only the *skill* marker makes it a claim; the role marker does not.
    const roleLine = "The `qa` role owns the probes.";
    expect(skillMentionAt(roleLine, "qa", roleLine.indexOf("`qa`"))).toBe(false);
  });
});

/**
 * Copy the gate into a fixture at `<fixture>/scripts/`, so it resolves its own
 * root. Both halves travel: a fixture carrying only `check-markdown-links.mjs`
 * would die on the policy import instead of on the rule under test.
 */
function copyGate(dir) {
  mkdirSync(join(dir, "scripts", "markdown-links"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, "scripts", "check-markdown-links.mjs"));
  copyFileSync(
    join(ROOT, "scripts", "markdown-links", "policy.mjs"),
    join(dir, "scripts", "markdown-links", "policy.mjs"),
  );
}

/**
 * CLI fixtures: a throwaway git repo under mkdtemp. The index is the resolution
 * base, so the fixture must be `git add`ed — that is the rule under test.
 */
function fixtureRepo(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "md-links-")));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  copyGate(dir);
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
    expect(run.stdout).toContain("3 code-span path claims + 1 skill names");
    expect(run.stdout).toContain("1 gitignored build paths skipped");
    // The line separates checked from resolved: the gitignored path is not resolved.
    expect(run.stdout).toContain("3 resolve");
    expect(run.stdout).toContain("0 record-file claims counted");
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

    // Stop ignoring it, keep it untracked: the gate refuses it though the file exists.
    writeFileSync(join(dir, ".gitignore"), "# nothing ignored\n");
    const untrackedRun = runFixture(dir);
    expect(untrackedRun.status).toBe(1);
    expect(untrackedRun.stderr).toContain("docs/living.md:1 -> docs/untracked.md");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reddens on a record's dead Markdown link through the CLI (B5)", () => {
    // A record's dead Markdown link is enforced through the CLI, not counted,
    // whatever the policy table's order.
    const dir = fixtureRepo({
      "adr/0044-vps-serving-path-cutover.md": [
        "# ADR-0044",
        "",
        "Retires `scripts/template-sync/`; see [the runbook](./VPS-CUTOVER-RUNBOOK.md).",
      ].join("\n"),
    });
    const run = runFixture(dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("1 dangling reference(s)");
    expect(run.stderr).toContain(
      "adr/0044-vps-serving-path-cutover.md:3 -> ./VPS-CUTOVER-RUNBOOK.md",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails loudly when the checkout has no git index", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "md-links-nogit-")));
    copyGate(dir);
    writeFileSync(join(dir, "SPECS.md"), "# spec\n");
    const run = spawnSync("bun", ["scripts/check-markdown-links.mjs"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("not a git checkout");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reddens on a dead `..` span and the same target in link form (#391)", () => {
    // One living doc, one dead target, both shapes, `git add -A`ed so the index is the base.
    const dir = fixtureRepo({
      ".agents/skills/ship/SKILL.md": [
        "# ship",
        "",
        "The runbook is `../../../docs/VPS-ABSENT.md` in span form.",
        "The runbook is [in link form](../../../docs/VPS-ABSENT.md).",
      ].join("\n"),
    });
    const run = runFixture(dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("2 dangling reference(s)");
    expect(run.stderr).toContain(".agents/skills/ship/SKILL.md:3 -> ../../../docs/VPS-ABSENT.md");
    expect(run.stderr).toContain(".agents/skills/ship/SKILL.md:4 -> ../../../docs/VPS-ABSENT.md");
    rmSync(dir, { recursive: true, force: true });
  });

  it("stays green on a `..` span that resolves, and prints it as checked (#391)", () => {
    const dir = fixtureRepo({
      ".agents/skills/ship/SKILL.md": "The runbook is `../../../docs/VPS-OPERATIONS.md`.\n",
      "docs/VPS-OPERATIONS.md": "# operations\n",
    });
    const run = runFixture(dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("1 code-span path claims + 0 skill names");
    expect(run.stdout).toContain("1 resolve");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reddens on a dead `./` span and the same target in link form (#396)", () => {
    // One living doc, one dead target, both shapes, `git add -A`ed so the index is the base.
    const dir = fixtureRepo({
      "docs/living.md": [
        "# Living doc",
        "",
        "The handler's default is `./apps/web/dist` in span form.",
        "The handler's default is [in link form](./apps/web/dist).",
      ].join("\n"),
    });
    const run = runFixture(dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("2 dangling reference(s)");
    expect(run.stderr).toContain("docs/living.md:3 -> ./apps/web/dist");
    expect(run.stderr).toContain("docs/living.md:4 -> ./apps/web/dist");
    // The reading is the file's directory, so the root base is not consulted here.
    expect(run.stderr).toContain("no such tracked path beside this file");
    rmSync(dir, { recursive: true, force: true });
  });

  it("stays green on a `./` span that resolves, and prints it as checked (#396)", () => {
    const dir = fixtureRepo({
      "docs/living.md": "The runbook is `./runbook.md` and [also here](./runbook.md).\n",
      "docs/runbook.md": "# runbook\n",
    });
    const run = runFixture(dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("1 relative links + 1 code-span path claims + 0 skill names");
    expect(run.stdout).toContain("2 resolve");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a malformed percent-encoded link instead of crashing (#392)", () => {
    const dir = fixtureRepo({ "docs/living.md": "See [pct](./100%.md).\n" });
    const run = runFixture(dir);
    expect(run.status).toBe(1);
    // The documented line, with its reason — not a Bun stack trace.
    expect(run.stderr).toContain("docs/living.md:1 -> ./100%.md  (malformed percent-encoding");
    expect(run.stderr).not.toContain("URIError");
    expect(run.stdout).not.toContain("markdown-links: OK");
    rmSync(dir, { recursive: true, force: true });
  });
});
