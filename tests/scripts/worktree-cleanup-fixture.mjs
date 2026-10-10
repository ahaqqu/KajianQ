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
 * behind every `worktree-cleanup*.test.mjs` case file, split out so the case
 * files stay case-only: `worktree-cleanup.test.mjs` (fixture behaviour),
 * `worktree-cleanup-isolation.test.mjs` (the real-checkout canary) and
 * `worktree-cleanup-destruction.test.mjs` (the deletion boundary).
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
 *
 * Destructive runs carry `--no-active-dispatches` by default (#239): the sweep
 * is gated, so the harness passes the acknowledgement for the cases whose
 * subject is a removal rule, and `{ withholdGate: true }` reproduces the
 * operator who forgot it. Lock state is driven through real
 * `git worktree lock`/`unlock` and asserted from git's own porcelain listing
 * (`lockState`), never from the script's parser.
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
// assertion here is what makes an undeclared state a loud failure. `env` adds
// variables to the run only — e.g. git's own trace target, see `gitCommands`.
//
// `--no-active-dispatches` is appended by default (#239): every case in this
// suite that expects a removal is a deliberate sweep, and the acknowledgement
// is a precondition of one. `{ withholdGate: true }` is the only way to run as
// an operator who forgot the flag — its own case, which must remove nothing and
// exit non-zero — and it is also how a case reaches an `--unlock` run, since
// unlocking destroys nothing and so is not gated.
function runClean(fx, args = [], env = {}, { withholdGate = false } = {}) {
  const result = fx.run(withholdGate ? args : [...args, "--no-active-dispatches"], env);
  expect(fx.unexpectedGhCalls()).toBe("");
  return result;
}

// The script's per-entry line grammar — its de-facto output contract. One line
// per entry the run examined: `removed <slug> (…)`, `kept  <slug>: …`,
// `would remove <slug> (…)`. Parsed here, beside `callLog`, so every case file
// reads the contract the same way; `summaryCounts` below is what keeps the
// parse honest, so an unknown future shape reddens a case instead of silently
// shrinking what it pins.
function entryLines(stdout) {
  return stdout.split("\n").flatMap((line) => {
    const match = /^(removed|kept|would remove) +([^\s:]+)/.exec(line);
    return match ? [{ verb: match[1], slug: match[2] }] : [];
  });
}

function namedSlugs(stdout) {
  return entryLines(stdout).map((entry) => entry.slug);
}

function removedSlugs(stdout) {
  return entryLines(stdout)
    .filter((entry) => entry.verb === "removed")
    .map((entry) => entry.slug);
}

// The run's own totals, from the `done: X removed, Y kept` line. Throws — with
// the whole output — when the shape is absent, so an early exit that printed no
// summary can never satisfy an accounting assertion by default.
function summaryCounts(stdout) {
  const match = /^done: (\d+) removed, (\d+) kept(?: \(dry run\))?$/m.exec(stdout);
  if (!match) throw new Error(`no "done:" summary line in the run's output:\n${stdout}`);
  return { removed: Number(match[1]), kept: Number(match[2]) };
}

// Every git command the run under test issued, from a trace file written by
// git's own trace2 event target (`GIT_TRACE2_EVENT`). Each entry is the argv
// after the program name plus the repository or worktree git discovered for it
// — observed at git's boundary, so it depends on nothing another dispatch can
// mutate. Events are grouped by git's session id: one repository discovery
// (`def_repo`) per command, when that command needed a repository at all.
function gitCommands(tracePath) {
  const commands = new Map();
  for (const line of readFileSync(tracePath, "utf8").split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line);
    const command = commands.get(event.sid) ?? { args: [], repo: null };
    if (event.event === "start") {
      const argv = event.argv ?? [];
      command.args = /(^|\/)git$/.test(argv[0] ?? "") ? argv.slice(1) : argv;
    }
    if (event.event === "def_repo") command.repo = event.worktree ?? null;
    commands.set(event.sid, command);
  }
  return [...commands.values()].filter((command) => command.args.length > 0);
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
  const run = (args = [], env = {}) =>
    spawnSync("bun", [SCRIPT, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...GIT_ENV, PATH: `${join(dir, "bin")}:${process.env.PATH}`, ...env },
    });

  function installGh({ prs = {}, noPr = [] } = {}) {
    mkdirSync(join(dir, "bin"), { recursive: true });
    const calls = join(dir, "gh-calls.log");
    const unexpected = join(dir, "gh-unexpected.log");
    const arms = [
      ...Object.entries(prs).map(([branch, pr]) => {
        // Only the verdict fields reach `gh`'s stdout: `before` is the arm's own
        // side effect, run before it answers. It is the seam a case needs to
        // change git state *during* the sweep — e.g. locking the worktree after
        // the run has already parsed `git worktree list`, the race rule 0
        // cannot see (#239).
        const verdict = JSON.stringify({ state: pr.state, headRefOid: pr.headRefOid });
        const sideEffect = pr.before ? `${pr.before}; ` : "";
        return `  'pr view ${branch} --json state,headRefOid') ${sideEffect}printf '%s' '${verdict}' ;;`;
      }),
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

  // The liveness declaration the tool reads (#239): a real `git worktree lock`
  // carrying the reason a dispatch would record, so no case has to reproduce
  // git's lock-file format. Path-addressed, so the A1 case can lock and read a
  // registered worktree outside .worktrees/ (#257).
  const lockAt = (path, reason) => {
    git(dir, ["worktree", "lock", path, ...(reason ? ["--reason", reason] : [])]);
  };

  // Git's own view of an entry's lock, read from the porcelain listing rather
  // than from the script's parser, so a case can assert what git holds
  // independently of what the run printed.
  const lockStateAt = (path) => {
    const block = git(dir, ["worktree", "list", "--porcelain"])
      .split("\n\n")
      .find((entry) => entry.startsWith(`worktree ${path}`));
    const line = (block ?? "").split("\n").find((l) => l === "locked" || l.startsWith("locked "));
    return { locked: line !== undefined, reason: line ? line.slice("locked".length).trim() : "" };
  };

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
    // A registered worktree OUTSIDE .worktrees/ — a sibling of the tool's own
    // root. Git knows it; the tool's scope does not, so it is the shape an
    // `--unlock` slug must never reach (#257 A1). Returns its path, which
    // `lockAt`/`lockStateAt` address directly.
    addOutside(name) {
      const path = join(dir, name);
      git(dir, ["worktree", "add", "-q", path, "-b", `agent/${name}`]);
      return path;
    },
    // A worktree whose directory name and branch intentionally disagree — the
    // shape the manager's own dispatch briefs produce (`.worktrees/agent-15`
    // checked out on `agent/router-stages-3-4`). The branch is the worktree's
    // truth; the slug is only a label.
    addCommittedOn(slug, branch) {
      git(dir, ["worktree", "add", "-q", wtPath(slug), "-b", branch]);
      writeFileSync(join(wtPath(slug), "wip.txt"), "work in progress\n");
      git(wtPath(slug), ["add", "wip.txt"]);
      git(wtPath(slug), ["commit", "-q", "-m", "wip"]);
      return git(wtPath(slug), ["rev-parse", "HEAD"]);
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
    // The liveness declaration the tool reads (#239): a real `git worktree lock`
    // carrying the reason a dispatch would record, so no case has to reproduce
    // git's lock-file format. The `…At` pair addresses a path directly, for the
    // out-of-tree shape the A1 case asserts on (#257).
    lock: (slug, reason) => lockAt(wtPath(slug), reason),
    lockAt,
    unlock(slug) {
      git(dir, ["worktree", "unlock", wtPath(slug)]);
    },
    // Git's own view of an entry's lock, read from the porcelain listing rather
    // than from the script's parser, so a case can assert what git holds
    // independently of what the run printed.
    lockState: (slug) => lockStateAt(wtPath(slug)),
    lockStateAt,
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

export {
  callLog,
  git,
  gitCommands,
  gitOk,
  MAIN_ROOT,
  makeFixture,
  namedSlugs,
  REAL_WORKTREES,
  removedSlugs,
  runClean,
  SCRIPT,
  summaryCounts,
};
