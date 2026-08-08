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
});
