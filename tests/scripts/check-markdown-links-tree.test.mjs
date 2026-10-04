// The docs:links gate against the real repository and through its CLI: the
// committed-tree rule, the allowlist's self-pruning, and what the entry point
// prints. The CLI fixtures copy the gate's modules into a throwaway git repo, so
// they exercise the same wiring CI runs.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    // The blind spots this change accepted must be printed on every green run.
    expect(out).toMatch(/\d+ known-retired allowlisted/);
    expect(out).toMatch(/\d+ dead claims inside record files unchecked/);
  });

  it("prints exactly what `runGate` decided — one driver, not two", () => {
    // The gate used to be implemented twice (`main()` and a `realScan()` here),
    // so the suite could pass against wiring the CLI no longer had. The CLI must
    // now print the same counters the tests assert on.
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
    // A5: "resolve" used to be the verb for the *checked* total, which counted
    // the 4 allowlisted and the 2 gitignored as if they had been proved. The
    // line now separates them, and this is the invariant that keeps it honest.
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
    // packages/infra/README.md:109 — `scripts/db-migrate.mjs`.
    const ctx = buildContext(ROOT);
    expect(judgeClaim("scripts/db-migrate.mjs", "packages/infra", ctx).status).toBe("ok");
  });

  it("resolves the `..` variant of that same control end to end (#391)", () => {
    // The control above is the header's blessed file-relative base. Written the
    // way this repository's `../` idiom writes it — from `docs/` — the identical
    // target must resolve, be counted as a claim, and stay green.
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

  it("covers every tracked top-level directory — the scope cannot shrink silently", () => {
    // CLAIM_ROOTS is the stated scope rule. A new top-level directory that does
    // not join it stops being a claim root, and this is what says so.
    const ctx = buildContext(ROOT);
    const topDirs = [...ctx.tree.dirs].filter((d) => !d.includes("/"));
    expect(topDirs.filter((d) => !CLAIM_ROOTS.includes(d))).toEqual([]);
    // And the roots the ticket names are all still there.
    for (const root of ["apps", "packages", "scripts", "docs", "adr", ".agents", ".zcode"]) {
      expect(topDirs).toContain(root);
    }
  });

  it("keeps record membership to real, tracked records", () => {
    // B4: the membership rule is stated in the header — a record is an executed
    // log or a decision record, never a living how-to. This pins that every
    // member is a real tracked path, so a typo cannot silently widen the
    // exemption the gate takes.
    const { tree } = buildContext(ROOT);
    for (const dir of RECORD_DIRS) expect(tree.dirs.has(dir), dir).toBe(true);
    for (const file of RECORD_FILES) expect(tree.files.has(file), file).toBe(true);
    // A record's own ADRs are records; a living doc is not.
    expect(isRecord("adr/0030-retire-template-sync.md")).toBe(true);
    expect(RECORD_DIRS.some((d) => isRecord(`${d}/x.md`))).toBe(true);
    for (const living of ["AGENTS.md", "SPECS.md", "docs/ARCHITECTURE.md"]) {
      expect(isRecord(living), living).toBe(false);
    }
  });

  it("distinguishes the two deliberately unchecked role markers", () => {
    // A2: "the `X` role" is not one namespace but two — live harness roles
    // (`.zcode/agents/<role>.md`) and model-stage names — plus one role retired
    // by ADR-0032. The harness namespace is a second *deliberately* unchecked
    // marker; this pins that it is neither empty nor a skill claim.
    const { tree } = buildContext(ROOT);
    for (const role of ["qa", "reviewer", "fixer"]) {
      expect(tree.files.has(`.zcode/agents/${role}.md`), role).toBe(true);
    }
    expect(tree.files.has(".zcode/agents/test-implementer.md")).toBe(false);
    expect(isSkillName("qa")).toBe(true);
    expect(scan("The `qa` role owns the probes.", { paths: [], skills: [] }).violations).toEqual(
      [],
    );
    // ...and only the *skill* marker makes it a claim — the role marker does
    // not, which is exactly the unchecked namespace this test documents.
    const roleLine = "The `qa` role owns the probes.";
    expect(skillMentionAt(roleLine, "qa", roleLine.indexOf("`qa`"))).toBe(false);
  });
});

/**
 * Copy the gate into a fixture at `<fixture>/scripts/` so it resolves its own
 * root from its own location. Both halves travel: the entry imports the policy
 * module, so a fixture that carried only `check-markdown-links.mjs` would die on
 * the import instead of on the rule under test.
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
 * base, so the fixture must be `git add`ed — that is the rule under test, not
 * incidental setup.
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
    // 2 path claims + 1 gitignored build path + 1 skill name.
    expect(run.stdout).toContain("3 code-span path claims + 1 skill names");
    expect(run.stdout).toContain("1 gitignored build paths skipped");
    // A5: the line separates what was checked from what resolved — the
    // gitignored one is checked and *not* resolved, and says so.
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

    // Stop ignoring it, keep it untracked: now the gate must refuse it, even
    // though the file is right there on disk.
    writeFileSync(join(dir, ".gitignore"), "# nothing ignored\n");
    const untrackedRun = runFixture(dir);
    expect(untrackedRun.status).toBe(1);
    expect(untrackedRun.stderr).toContain("docs/living.md:1 -> docs/untracked.md");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reddens on a record's dead Markdown link through the CLI (B5)", () => {
    // The shipping path for the B5 property: a reshuffle of `POLICY` used to
    // make this exit 0 and print the link as a counted record claim.
    const dir = fixtureRepo({
      "adr/0030-retire-template-sync.md": [
        "# ADR-0030",
        "",
        "Retires `scripts/template-sync/`; see [the runbook](./VPS-CUTOVER-RUNBOOK.md).",
      ].join("\n"),
    });
    const run = runFixture(dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("1 dangling reference(s)");
    expect(run.stderr).toContain("adr/0030-retire-template-sync.md:3 -> ./VPS-CUTOVER-RUNBOOK.md");
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
    // The QA round's failing probe, end to end: one living doc, one dead
    // target, both shapes, `git add -A`ed so the index is the base. Before the
    // fix only the link line reddened; the span line was not even counted.
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
