import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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

    // Seed upstream with template-owned and merge files.
    writeFileSync(`${upstream}/AGENTS.md`, "template agents\n");
    writeFileSync(`${upstream}/README.md`, "template readme\n");
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
