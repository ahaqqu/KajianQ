import { describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

/**
 * `bun run worktree:clean` — the disposable-worktree rule (#229).
 *
 * Every run is hermetic: the script resolves its root from
 * `git rev-parse --show-toplevel` of its cwd, so each case builds a throwaway
 * fixture repo under `mkdtempSync` and runs the script with `cwd` there. The
 * real checkout's `.worktrees/` and branches are never in the script's scope.
 *
 * `gh` is intercepted by a fixture `bin/gh` prepended to `PATH` rather than by
 * an env seam in the script: the script already resolves `gh` through the
 * inherited PATH, so the fake needs no production-only branch. The fake logs
 * every invocation, so a test proves the MERGED and no-PR paths were consulted
 * instead of silently degrading to "no PR" when the network is absent.
 *
 * A fixture is removed only after a test's assertions pass; a failure leaves
 * the fixture repo on disk (its path is logged) so the state is inspectable.
 */

const REAL_WORKTREE_ROOT = realpathSync(process.cwd());
const SCRIPT = resolve(REAL_WORKTREE_ROOT, "scripts/worktree-cleanup.mjs");
const MAIN_ROOT = realpathSync(
  execFileSync("git", ["-C", REAL_WORKTREE_ROOT, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  })
    .split("\n")[0]
    .replace(/^worktree /, "")
    .trim(),
);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

function gitOk(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).status === 0;
}

function makeFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-clean-")));
  if (dir === MAIN_ROOT || dir.startsWith(MAIN_ROOT + "/")) {
    throw new Error(`fixture would live inside the real checkout: ${dir}`);
  }
  console.log(`fixture: ${dir}`);

  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "base"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  const wtPath = (slug) => join(dir, ".worktrees", slug);
  const run = (args = []) =>
    spawnSync("bun", [SCRIPT, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...GIT_ENV, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
    });

  return {
    dir,
    wtPath,
    run,
    addUnstarted(slug) {
      git(dir, ["worktree", "add", "-q", wtPath(slug), "-b", `agent/${slug}`]);
    },
    addDetached(slug) {
      git(dir, ["worktree", "add", "-q", "--detach", wtPath(slug), "origin/main"]);
    },
    addCommitted(slug) {
      git(dir, ["worktree", "add", "-q", wtPath(slug), "-b", `agent/${slug}`]);
      writeFileSync(join(wtPath(slug), "wip.txt"), "work in progress\n");
      git(wtPath(slug), ["add", "wip.txt"]);
      git(wtPath(slug), ["commit", "-q", "-m", "wip"]);
    },
    fakeGh(state) {
      mkdirSync(join(dir, "bin"), { recursive: true });
      const calls = join(dir, "gh-calls.log");
      const script =
        "#!/bin/sh\n" +
        `printf '%s\\n' "$*" >> '${calls}'\n` +
        (state === null ? "exit 1\n" : `printf '%s' '${state}'\n`);
      writeFileSync(join(dir, "bin", "gh"), script);
      chmodSync(join(dir, "bin", "gh"), 0o755);
    },
    ghCalls() {
      const log = join(dir, "gh-calls.log");
      return existsSync(log) ? readFileSync(log, "utf8") : "";
    },
    exists(slug) {
      return existsSync(wtPath(slug));
    },
    branchExists(branch) {
      return gitOk(dir, ["rev-parse", "--verify", "--quiet", branch]);
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("worktree-cleanup", () => {
  it("keeps a zero-commit worktree by default and prints why", () => {
    const fx = makeFixture();
    fx.addUnstarted("unstarted");
    fx.fakeGh(null);

    // The exact pre-fix shape: the branch is an ancestor of origin/main, which
    // the old rule 2 matched and reported as "already in origin/main" before
    // removing it. A dispatch that has not committed yet looks like this.
    expect(gitOk(fx.dir, ["merge-base", "--is-ancestor", "agent/unstarted", "origin/main"])).toBe(
      true,
    );

    const result = fx.run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kept  unstarted");
    expect(result.stdout).toMatch(/no unique commits vs origin\/main/);
    expect(result.stdout).toContain("--include-unstarted");
    expect(result.stdout).toContain("done: 0 removed, 1 kept");
    expect(fx.exists("unstarted")).toBe(true);
    expect(fx.branchExists("agent/unstarted")).toBe(true);
    expect(fx.ghCalls()).toContain("pr view agent/unstarted");
    fx.dispose();
  });

  it("removes a zero-commit worktree only with --include-unstarted", () => {
    const fx = makeFixture();
    fx.addUnstarted("unstarted");
    fx.fakeGh(null);

    const result = fx.run(["--include-unstarted"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("removed unstarted");
    expect(result.stdout).toMatch(/no unique commits vs origin\/main/);
    expect(result.stdout).toContain("done: 1 removed, 0 kept");
    expect(fx.exists("unstarted")).toBe(false);
    expect(fx.branchExists("agent/unstarted")).toBe(false);
    fx.dispose();
  });

  it("keeps a detached review worktree by default and prints why", () => {
    const fx = makeFixture();
    fx.addDetached("review-7");
    fx.fakeGh(null);

    const result = fx.run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kept  review-7");
    expect(result.stdout).toMatch(/no agent\/review-7 branch/);
    expect(result.stdout).toContain("--include-detached");
    expect(result.stdout).toContain("done: 0 removed, 1 kept");
    expect(fx.exists("review-7")).toBe(true);
    expect(fx.branchExists("agent/review-7")).toBe(false);
    fx.dispose();
  });

  it("removes a detached review worktree only with --include-detached", () => {
    const fx = makeFixture();
    fx.addDetached("review-7");
    fx.fakeGh(null);

    const result = fx.run(["--include-detached"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("removed review-7");
    expect(result.stdout).toContain("done: 1 removed, 0 kept");
    expect(fx.exists("review-7")).toBe(false);
    fx.dispose();
  });

  it("removes a merged-PR worktree by default as the first rule", () => {
    const fx = makeFixture();
    fx.addCommitted("merged");
    fx.fakeGh("MERGED");

    const result = fx.run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("removed merged (PR merged)");
    expect(fx.exists("merged")).toBe(false);
    expect(fx.branchExists("agent/merged")).toBe(false);
    // The MERGED verdict came from the fixture seam, not from a network call.
    expect(fx.ghCalls()).toContain("pr view agent/merged");
    fx.dispose();
  });

  it("keeps a no-PR worktree with unmerged commits", () => {
    const fx = makeFixture();
    fx.addCommitted("wip");
    fx.fakeGh(null);

    const result = fx.run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kept  wip");
    expect(result.stdout).toMatch(/unmerged work/);
    expect(fx.exists("wip")).toBe(true);
    expect(fx.branchExists("agent/wip")).toBe(true);
    // The no-PR verdict came from the fixture seam, not from a network call.
    expect(fx.ghCalls()).toContain("pr view agent/wip");
    fx.dispose();
  });

  it("skips a dirty worktree without --force, even with the unstarted flag", () => {
    const fx = makeFixture();
    fx.addUnstarted("dirty");
    fx.fakeGh(null);
    writeFileSync(join(fx.wtPath("dirty"), "scratch.txt"), "uncommitted\n");

    const withoutForce = fx.run(["--include-unstarted"]);

    expect(withoutForce.status).toBe(0);
    expect(withoutForce.stdout).toContain("kept  dirty: dirty worktree");
    expect(fx.exists("dirty")).toBe(true);

    const forced = fx.run(["--include-unstarted", "--force"]);

    expect(forced.status).toBe(0);
    expect(forced.stdout).toContain("removed dirty");
    expect(fx.exists("dirty")).toBe(false);
    fx.dispose();
  });

  it("resolves its root from the fixture repo, never the real checkout", () => {
    const fx = makeFixture();
    fx.addUnstarted("unstarted");
    fx.fakeGh(null);

    expect(realpathSync(git(fx.dir, ["rev-parse", "--show-toplevel"]))).toBe(fx.dir);

    const result = fx.run(["--include-unstarted"]);
    expect(result.status).toBe(0);

    // The real checkout gained neither the fixture worktree nor its branch.
    expect(existsSync(join(MAIN_ROOT, ".worktrees", "unstarted"))).toBe(false);
    expect(gitOk(MAIN_ROOT, ["rev-parse", "--verify", "--quiet", "agent/unstarted"])).toBe(false);
    fx.dispose();
  });
});
