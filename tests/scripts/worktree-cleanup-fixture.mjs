import { expect } from "vitest";
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
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

/**
 * Fixture harness for the `bun run worktree:clean` cases (#229) — the plumbing
 * behind `worktree-cleanup.test.mjs`, split out so the case file stays
 * case-only and a second case file can share it.
 *
 * Every run is hermetic: the script resolves its root from
 * `git rev-parse --show-toplevel` of its cwd, so each case builds a throwaway
 * fixture repo under `mkdtempSync` and runs the script with `cwd` there. The
 * real checkout's `.worktrees/` and branches are never in the script's scope.
 *
 * `gh` is intercepted by a fixture `bin/gh` prepended to `PATH` rather than by
 * an env seam in the script: the script already resolves `gh` through the
 * inherited PATH, so the fake needs no production-only branch. The fake serves
 * a verdict only for the exact invocation a test declares — a branch with a PR
 * gets its JSON, a branch listed as no-PR exits the way `gh` does when nothing
 * matches, and anything else is recorded and fails loudly. `runClean` asserts
 * that record is empty on every run, so an undeclared lookup can never be
 * silently absorbed as "no PR", and a test can prove the MERGED path was
 * consulted instead of degrading when the network is absent.
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
const REAL_WORKTREES = join(MAIN_ROOT, ".worktrees");

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

function callLog(fx) {
  return fx.ghCalls().trim() === "" ? [] : fx.ghCalls().trim().split("\n");
}

// Run and reject any gh lookup the test did not declare. The fixture gh records
// those and exits non-zero; the script would swallow that as "no PR", so the
// assertion here is what makes an undeclared state a loud failure.
function runClean(fx, args = []) {
  const result = fx.run(args);
  expect(fx.unexpectedGhCalls()).toBe("");
  return result;
}

function makeFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-clean-")));
  if (dir === MAIN_ROOT || dir.startsWith(MAIN_ROOT + "/")) {
    throw new Error(`fixture would live inside the real checkout: ${dir}`);
  }
  console.log(`fixture: ${dir}`);

  git(dir, ["init", "-q", "-b", "main"]);
  // Mirror the real checkout: .worktrees/ (and the fixture's own bookkeeping)
  // never show up as untracked in the fixture repo.
  writeFileSync(join(dir, ".gitignore"), ".worktrees/\nbin/\ngh-calls.log\ngh-unexpected.log\n");
  git(dir, ["add", ".gitignore"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  const wtPath = (slug) => join(dir, ".worktrees", slug);
  const run = (args = []) =>
    spawnSync("bun", [SCRIPT, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...GIT_ENV, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
    });

  function installGh({ prs = {}, noPr = [] } = {}) {
    mkdirSync(join(dir, "bin"), { recursive: true });
    const calls = join(dir, "gh-calls.log");
    const unexpected = join(dir, "gh-unexpected.log");
    const arms = [
      ...Object.entries(prs).map(
        ([branch, pr]) =>
          `  'pr view ${branch} --json state,headRefOid') printf '%s' '${JSON.stringify(pr)}' ;;`,
      ),
      ...noPr.map(
        (branch) =>
          `  'pr view ${branch} --json state,headRefOid') printf 'no pull requests found for %s\\n' '${branch}' >&2; exit 1 ;;`,
      ),
    ].join("\n");
    writeFileSync(
      join(dir, "bin", "gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$*" in
${arms}
  *) printf '%s\\n' "$*" >> '${unexpected}'; printf 'unexpected gh invocation: %s\\n' "$*" >&2; exit 3 ;;
esac
`,
    );
    chmodSync(join(dir, "bin", "gh"), 0o755);
  }

  // Refuse everything until a test declares what it expects, so a missing
  // declaration can never reach the real gh.
  installGh();

  return {
    dir,
    wtPath,
    run,
    fakeGh: installGh,
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
      return git(wtPath(slug), ["rev-parse", "HEAD"]);
    },
    // Move main and origin/main on, leaving earlier branches strictly behind.
    advanceOrigin() {
      writeFileSync(join(dir, "advance.txt"), "advance\n");
      git(dir, ["add", "advance.txt"]);
      git(dir, ["commit", "-q", "-m", "advance main"]);
      git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      return git(dir, ["rev-parse", "HEAD"]);
    },
    ghCalls() {
      const log = join(dir, "gh-calls.log");
      return existsSync(log) ? readFileSync(log, "utf8") : "";
    },
    unexpectedGhCalls() {
      const log = join(dir, "gh-unexpected.log");
      return existsSync(log) ? readFileSync(log, "utf8") : "";
    },
    exists(slug) {
      return existsSync(wtPath(slug));
    },
    branchExists(branch) {
      return gitOk(dir, ["rev-parse", "--verify", "--quiet", branch]);
    },
    // A stale ref lock: git refuses to rewrite the ref while the file exists,
    // so `git branch -D` fails deterministically, while `rev-parse` still
    // resolves the branch — the lock blocks writes, not reads.
    refLock(ref) {
      const lock = join(dir, ".git", `${ref}.lock`);
      mkdirSync(dirname(lock), { recursive: true });
      writeFileSync(lock, "");
      return lock;
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export { callLog, git, gitOk, MAIN_ROOT, makeFixture, REAL_WORKTREES, runClean };
