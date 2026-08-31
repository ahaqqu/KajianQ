import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execSync } from "node:child_process";

const ROOT = process.cwd();
const CLI = `${ROOT}/scripts/template-sync/cli.mjs`;

function run(dir, args, extraEnv = {}) {
  const result = spawnSync("bun", [CLI, ...args.split(/\s+/)], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, TEMPLATE_SYNC_CWD: dir, ...extraEnv },
  });
  if (result.status !== 0) {
    throw new Error(
      `Command failed: bun ${CLI} ${args}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function git(dir, args) {
  return execSync(`git ${args}`, { cwd: dir, encoding: "utf8" }).trim();
}

function setupRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), name));
  git(dir, "init --quiet");
  git(dir, "config user.email test@example.com");
  git(dir, "config user.name Test");
  git(dir, "config protocol.file.allow always");
  return dir;
}

function commit(dir, msg) {
  git(dir, "add -A");
  git(dir, `commit -m "${msg}" --quiet`);
}

/** writeFileSync that creates parent directories. */
function writeFile(file, data) {
  mkdirSync(file.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(file, data);
}

function makeFork(upstream) {
  const dir = mkdtempSync(join(tmpdir(), "fork-"));
  execSync(`git clone --quiet ${upstream} ${dir}`);
  git(dir, "config user.email test@example.com");
  git(dir, "config user.name Test");
  git(dir, "config protocol.file.allow always");
  // Simulate a real fork: origin points to the fork, not the template.
  git(dir, `remote set-url origin ${dir}`);
  return dir;
}

describe("template-sync CLI", () => {
  let upstream;
  let fork;

  beforeEach(() => {
    upstream = setupRepo("upstream-");

    // Seed upstream with template-owned, merge, and project-owned files.
    // NOTES.md is deliberately non-manifest and present at the merge base so
    // conflict scenarios below can exercise both-side edits and deletions.
    writeFileSync(`${upstream}/AGENTS.md`, "template agents\n");
    writeFileSync(`${upstream}/README.md`, "template readme\n");
    writeFileSync(`${upstream}/NOTES.md`, "template notes\n");
    commit(upstream, "initial");
    git(upstream, "tag v1.0.0");

    // Fork: clone upstream, add project-specific manifest.
    fork = makeFork(upstream);
    writeFileSync(`${fork}/template-sync.json`, JSON.stringify({
      upstream: `${upstream}`,
      overwrite: ["AGENTS.md"],
      merge: ["README.md"],
    }));
    writeFileSync(`${fork}/project.txt`, "project file\n");
    commit(fork, "add manifest");
  });

  afterEach(() => {
    rmSync(upstream, { recursive: true, force: true });
    rmSync(fork, { recursive: true, force: true });
  });

  it("init fetches the upstream remote", () => {
    const out = run(fork, "init", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    expect(out).toContain("upstream fetched");
    expect(git(fork, "remote get-url upstream")).toBe(`${upstream}`);
  });

  it("check passes after first sync", () => {
    run(fork, "init", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    run(fork, "update --ref=v1.0.0", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    const out = run(fork, "check", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    expect(out).toContain("gate passed");
  });

  it("check fails when a template-owned file drifts", () => {
    run(fork, "init", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    run(fork, "update --ref=v1.0.0", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    writeFileSync(`${fork}/AGENTS.md`, "drift\n");
    expect(() =>
      run(fork, "check", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` }),
    ).toThrow();
  });

  it("scopes drift to the template baseline for ALL overwrite paths — fork additions under overwrite dirs stay green (generalizes review A1)", () => {
    // A live fork-sync run (KajianQ) flagged ~20 fork-added files under
    // overwrite directories (`.agents/skills/`, `.github/workflows/`,
    // `scripts/`) as permanent `template-gate` drift, contradicting the
    // documented fork-extension story. Drift on every overwrite path is
    // therefore baseline-scoped: only files the template baseline actually
    // ships can be drift (their modification or deletion); fork additions
    // are sanctioned extensions (review B1 on PR #128; the pre-PR code
    // carried a `.zcode/` special case since removed with its overwrite
    // ownership).
    writeFile(`${upstream}/.agents/skills/upstream-skill/SKILL.md`, "template skill\n");
    writeFile(`${upstream}/.github/workflows/ci.yml`, "template workflow\n");
    commit(upstream, "ship agents + workflows");
    git(upstream, "tag v1.3.0");

    // The fork opts the directories into overwrite and carries fork-added
    // files: a committed skill, an untracked workflow, and a fork-added
    // file in a dir the template ships nothing under.
    writeFileSync(`${fork}/template-sync.json`, JSON.stringify({
      upstream: `${upstream}`,
      overwrite: ["AGENTS.md", ".agents/skills/", ".github/workflows/"],
      merge: ["README.md"],
    }));
    writeFile(`${fork}/.agents/skills/fork-skill/SKILL.md`, "fork skill\n");
    writeFile(`${fork}/.github/workflows/fork.yml`, "fork workflow\n");
    commit(fork, "fork additions under overwrite dirs");
    run(fork, "init", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    run(fork, "update --ref=v1.3.0", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    // An untracked fork draft in an overwrite dir is also sanctioned (the
    // existing `update` requires a clean tree, so it lands after the sync).
    writeFile(`${fork}/.agents/skills/fork-untracked/SKILL.md`, "fork draft\n");
    expect(run(fork, "check", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` })).toContain("gate passed");

    // Modifying a file the template baseline ships is still drift.
    writeFileSync(`${fork}/.agents/skills/upstream-skill/SKILL.md`, "fork edit\n");
    expect(() =>
      run(fork, "check", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` }),
    ).toThrow(/gate failed/);
    git(fork, "checkout -- .agents/skills/upstream-skill/SKILL.md");

    // Deleting a template-shipped overwrite file is still drift.
    execSync(`git rm --quiet .github/workflows/ci.yml`, { cwd: fork });
    commit(fork, "fork deletes template workflow");
    expect(() =>
      run(fork, "check", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` }),
    ).toThrow(/gate failed/);
    git(fork, "revert --no-edit HEAD");

    // Renaming a template-shipped overwrite file away is still drift
    // (review A1 on PR #128): rename detection must not transmute the
    // in-baseline delete into an out-of-baseline add that escapes the
    // filter. With --no-renames the rename reports D (in baseline → drift)
    // plus A of the new path (not in baseline → sanctioned), so the gate
    // must fail.
    execSync(`git mv .github/workflows/ci.yml .github/workflows/renamed.yml`, { cwd: fork });
    commit(fork, "fork renames template workflow away");
    expect(() =>
      run(fork, "check", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` }),
    ).toThrow(/gate failed/);
    git(fork, "revert --no-edit HEAD");
  });

  it("detects drift on non-ASCII template-shipped overwrite files (review A2 quotePath escape)", () => {
    // core.quotePath (git default on) makes the drift diff emit non-ASCII
    // paths octal-quoted (`"caf\303\251.yml"`); the quoted literal never
    // matches a real baseline path, so modify/delete of such files escaped
    // the filter silently. The drift listing must unquote (quotePath=false)
    // and the gate must red on a fork edit of a non-ASCII-named
    // template-shipped file.
    writeFile(`${upstream}/.github/workflows/café.yml`, "template workflow\n");
    commit(upstream, "ship non-ascii workflow");
    git(upstream, "tag v1.4.0");

    // The fork opts the workflows dir into overwrite before syncing.
    writeFileSync(`${fork}/template-sync.json`, JSON.stringify({
      upstream: `${upstream}`,
      overwrite: ["AGENTS.md", ".github/workflows/"],
      merge: ["README.md"],
    }));
    commit(fork, "opt workflows into overwrite");
    run(fork, "init", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    run(fork, "update --ref=v1.4.0", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    expect(
      run(fork, "check", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` }),
    ).toContain("gate passed");

    writeFileSync(`${fork}/.github/workflows/café.yml`, "fork edit\n");
    expect(() =>
      run(fork, "check", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` }),
    ).toThrow(/gate failed/);
  });

  it("update auto-resolves overwrite-path add/add to the template's version (review B1)", () => {
    // The template ADDS a file at a path the fork already carries under an
    // overwrite dir. The fork opts the directory into overwrite, so this is
    // a real overwrite-path add/add conflict which `update` must resolve to
    // the template's version (visible clobber semantics) and leave the gate
    // green — not hand back to the human and not keep the fork's copy
    // (which is what the non-manifest --ours path would do).
    writeFile(`${upstream}/.agents/skills/fork-skill/SKILL.md`, "template skill v2\n");
    commit(upstream, "template adds a file the fork already has");
    git(upstream, "tag v1.5.0");

    writeFileSync(`${fork}/template-sync.json`, JSON.stringify({
      upstream: `${upstream}`,
      overwrite: ["AGENTS.md", ".agents/skills/"],
      merge: ["README.md"],
    }));
    writeFile(`${fork}/.agents/skills/fork-skill/SKILL.md`, "fork skill\n");
    commit(fork, "fork already carries the same path");

    run(fork, "init", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    const out = run(fork, "update --ref=v1.5.0", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    expect(out).toContain("sync merged");
    // Template version wins the add/add; the fork's copy is overwritten.
    expect(readFileSync(`${fork}/.agents/skills/fork-skill/SKILL.md`, "utf8")).toBe(
      "template skill v2\n",
    );
    const check = run(fork, "check", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    expect(check).toContain("gate passed");
  });

  it("update merges upstream changes into template-owned files", () => {
    writeFileSync(`${upstream}/AGENTS.md`, "template agents v2\n");
    commit(upstream, "v2");
    git(upstream, "tag v1.1.0");

    run(fork, "init", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    run(fork, "update --ref=v1.1.0", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });

    expect(readFileSync(`${fork}/AGENTS.md`, "utf8")).toBe("template agents v2\n");
  });

  it("update is idempotent", () => {
    run(fork, "init", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    run(fork, "update --ref=v1.0.0", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    const second = run(fork, "update --ref=v1.0.0", {
      TEMPLATE_SYNC_UPSTREAM: `${upstream}`,
    });
    expect(second).toContain("already up to date");
  });

  it("update with no --ref follows the recorded state ref, not a stale older tag", () => {
    // Upstream: v1.0.0 at initial, then advance main, tag v1.1.0 at an
    // intermediate commit, then advance main further — so v1.1.0 is an
    // ancestor of main, not the tip. A tree-copy fork seeded against main
    // must follow state.ref (main) on the next update, not the stale v1.1.0
    // tag, which would merge backwards and downgrade overwrite files.
    writeFileSync(`${upstream}/AGENTS.md`, "template agents v2\n");
    commit(upstream, "v2");
    git(upstream, "tag v1.1.0");
    writeFileSync(`${upstream}/AGENTS.md`, "template agents v3\n");
    commit(upstream, "v3");

    // Tree-copy fork: overwrite file matches main HEAD; merge file is custom.
    const dir = setupRepo("stale-tag-");
    git(dir, `remote add upstream ${upstream}`);
    writeFileSync(`${dir}/AGENTS.md`, "template agents v3\n");
    writeFileSync(`${dir}/README.md`, "my fork readme\n");
    writeFileSync(`${dir}/template-sync.json`, JSON.stringify({
      upstream: `${upstream}`,
      overwrite: ["AGENTS.md"],
      merge: ["README.md"],
    }));
    commit(dir, "tree-copy bootstrap");

    run(dir, "init", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    // Seed against the upstream default branch (master in the test repo),
    // matching a tree-copy fork bootstrapped from the template's main line.
    run(dir, "seed --ref=master", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });

    // Advance upstream main beyond v1.1.0.
    writeFileSync(`${upstream}/AGENTS.md`, "template agents v4\n");
    commit(upstream, "v4");

    run(dir, "init", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    // No --ref: must follow state.ref (main), not the stale v1.1.0 tag.
    const out = run(dir, "update", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    expect(out).toContain("sync merged");
    // Overwrite file advances to the template's latest (v4), not the stale
    // tag's v2.
    expect(readFileSync(`${dir}/AGENTS.md`, "utf8")).toBe("template agents v4\n");
    // Merge-path file keeps the fork's content.
    expect(readFileSync(`${dir}/README.md`, "utf8")).toBe("my fork readme\n");

    rmSync(dir, { recursive: true, force: true });
  });

  it("update auto-resolves unrelated-history merge-path conflicts with --ours", () => {
    // A tree-copy fork (no shared git history) has the same overwrite files as
    // upstream but customized merge files. The first sync merges with
    // --allow-unrelated-histories; overwrite files resolve to the template,
    // merge-path files keep the fork's content (--ours).
    const dir = setupRepo("treecopy-update-");
    git(dir, `remote add upstream ${upstream}`);
    // Overwrite file matches upstream v1.0.0; merge file is fork-customized.
    writeFileSync(`${dir}/AGENTS.md`, "template agents\n");
    writeFileSync(`${dir}/README.md`, "my fork readme\n");
    writeFileSync(`${dir}/template-sync.json`, JSON.stringify({
      upstream: `${upstream}`,
      overwrite: ["AGENTS.md"],
      merge: ["README.md"],
    }));
    commit(dir, "tree-copy bootstrap");

    // Advance upstream's overwrite file.
    writeFileSync(`${upstream}/AGENTS.md`, "template agents v2\n");
    commit(upstream, "v2");
    git(upstream, "tag v1.1.0");

    run(dir, "init", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    const out = run(dir, "update --ref=v1.1.0", {
      TEMPLATE_SYNC_UPSTREAM: `${upstream}`,
    });
    expect(out).toContain("sync merged");
    // Overwrite file takes the template's version.
    expect(readFileSync(`${dir}/AGENTS.md`, "utf8")).toBe("template agents v2\n");
    // Merge-path file keeps the fork's content, not the template's.
    expect(readFileSync(`${dir}/README.md`, "utf8")).toBe("my fork readme\n");

    rmSync(dir, { recursive: true, force: true });
  });

  it("update auto-resolves non-manifest conflicts with the fork's version", () => {
    // A shared-history merge can conflict on project-owned paths (both sides
    // edit the same file). Those paths are not in the manifest, so the
    // template must never leave them for a human: update resolves them to the
    // fork's version and completes on its own.
    writeFileSync(`${upstream}/NOTES.md`, "template notes v2\n");
    commit(upstream, "notes v2");
    git(upstream, "tag v1.2.0");

    writeFileSync(`${fork}/NOTES.md`, "fork notes\n");
    commit(fork, "fork notes");

    const out = run(fork, "update --ref=v1.2.0", {
      TEMPLATE_SYNC_UPSTREAM: `${upstream}`,
    });
    expect(out).toContain("sync merged");
    expect(readFileSync(`${fork}/NOTES.md`, "utf8")).toBe("fork notes\n");
    // The gate is green right after the sync — no manual cleanup needed.
    const check = run(fork, "check", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    expect(check).toContain("gate passed");
  });

  it("update removes non-manifest paths the fork deleted, despite upstream edits", () => {
    writeFileSync(`${upstream}/NOTES.md`, "template notes v2\n");
    commit(upstream, "notes v2");
    git(upstream, "tag v1.2.0");

    execSync(`git rm --quiet NOTES.md`, { cwd: fork });
    commit(fork, "delete notes");

    const out = run(fork, "update --ref=v1.2.0", {
      TEMPLATE_SYNC_UPSTREAM: `${upstream}`,
    });
    expect(out).toContain("sync merged");
    expect(existsSync(`${fork}/NOTES.md`)).toBe(false);
  });

  it("update still defers merge-path conflicts to a human", () => {
    // Merge paths are fork-customizable by design, so a real conflict there
    // (both sides edited) must fail the sync for manual resolution.
    writeFileSync(`${upstream}/README.md`, "template readme v2\n");
    commit(upstream, "readme v2");
    git(upstream, "tag v1.2.0");

    writeFileSync(`${fork}/README.md`, "fork readme\n");
    commit(fork, "fork readme");

    expect(() =>
      run(fork, "update --ref=v1.2.0", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` }),
    ).toThrow(/merge conflicts remain/);
  });

  it("normalizes GitHub SSH upstream to HTTPS for git operations", () => {
    writeFileSync(`${fork}/template-sync.json`, JSON.stringify({
      upstream: "git@github.com:ahaqqu/agentic-project-template.git",
      overwrite: ["AGENTS.md"],
      merge: ["README.md"],
    }));
    commit(fork, "ssh upstream");
    // The env override proves the mechanism works; the manifest itself is SSH.
    const out = run(fork, "init", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    expect(out).toContain("upstream fetched");
  });

  it("seed records state without merging, then check enforces drift", () => {
    // Simulate a tree-copy bootstrap: the fork has the same template-owned
    // file content as upstream v1.0.0, but no shared git history.
    const dir = setupRepo("treecopy-");
    git(dir, `remote add upstream ${upstream}`);
    writeFileSync(`${dir}/AGENTS.md`, "template agents\n");
    writeFileSync(`${dir}/template-sync.json`, JSON.stringify({
      upstream: `${upstream}`,
      overwrite: ["AGENTS.md"],
      merge: ["README.md"],
    }));
    commit(dir, "tree-copy bootstrap");

    run(dir, "init", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    const out = run(dir, "seed --ref=v1.0.0", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    expect(out).toContain("state seeded");

    // check now enforces (no longer "no sync state found").
    const check = run(dir, "check", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    expect(check).toContain("gate passed");

    rmSync(dir, { recursive: true, force: true });
  });

  it("seed refuses when template-owned files do not match the target ref", () => {
    const dir = setupRepo("drifted-");
    git(dir, `remote add upstream ${upstream}`);
    writeFileSync(`${dir}/AGENTS.md`, "drifted content\n");
    writeFileSync(`${dir}/template-sync.json`, JSON.stringify({
      upstream: `${upstream}`,
      overwrite: ["AGENTS.md"],
      merge: ["README.md"],
    }));
    commit(dir, "drifted bootstrap");

    run(dir, "init", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    expect(() =>
      run(dir, "seed --ref=v1.0.0", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` }),
    ).toThrow();

    rmSync(dir, { recursive: true, force: true });
  });

  it("seed is idempotent — re-seeding the same ref is a no-op", () => {
    const dir = setupRepo("idempotent-");
    git(dir, `remote add upstream ${upstream}`);
    writeFileSync(`${dir}/AGENTS.md`, "template agents\n");
    writeFileSync(`${dir}/template-sync.json`, JSON.stringify({
      upstream: `${upstream}`,
      overwrite: ["AGENTS.md"],
      merge: ["README.md"],
    }));
    commit(dir, "bootstrap");

    run(dir, "init", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    run(dir, "seed --ref=v1.0.0", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    const second = run(dir, "seed --ref=v1.0.0", { TEMPLATE_SYNC_UPSTREAM: `${upstream}` });
    expect(second).toContain("state already recorded");

    rmSync(dir, { recursive: true, force: true });
  });
});
