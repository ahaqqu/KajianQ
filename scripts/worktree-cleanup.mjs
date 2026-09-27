#!/usr/bin/env bun
// Remove manager-skill subagent worktrees (.worktrees/<slug>) whose work is
// safely disposable: a worktree is removable when it is NOT locked (rule 0) and
// ANY of these holds:
//   1. its GitHub PR reports state MERGED AND the PR's head commit is the branch
//      tip (squash-safe — history was rewritten). `gh pr view <branch>` answers
//      by branch name from PR history, so the state alone is not a disposal
//      signal: a re-dispatched slug reuses a merged PR's name, and commits made
//      after that PR merged exist only on the branch;
//   2. it has no unique commits vs origin/main (falling back to local main),
//      AND --include-unstarted was passed;
//   3. it has no agent/<slug> branch — a detached review checkout, or one
//      orphaned by an earlier sweep — AND --include-detached was passed.
// Rules 2 and 3 are KEPT by default with the reason printed: with no commits or
// no branch, "abandoned" and "a dispatch or review still in flight" are
// indistinguishable, and that worktree is the most expensive to lose and the
// cheapest to sweep later. Rule 2 also covers a branch already contained in
// main — merged there without a PR, or fast-forward-merged with one: zero unique
// commits either way, so it is kept by default and swept only with
// --include-unstarted. Rule 2 outranks rule 1, so a default run never removes a
// zero-unique-commit worktree whatever PR history says about its name. Branches
// with unmerged commits are always KEPT. Dirty worktrees are skipped unless
// --force. A .worktrees/ entry that is not a registered git worktree (a stray
// file or directory) is reported and skipped, never removed, so one stray entry
// cannot abort the run. So is a registered worktree whose git commands fail —
// a stale gitdir: the failure is that entry's keep, not the run's. An entry
// whose worktree removal succeeds but whose branch delete then fails is still
// printed and counted as removed, with the branch failure and the manual remedy
// (`git branch -D`) named in the same line: the removal happened, and a `kept`
// prefix would contradict it. This is the one failure state no later sweep
// revisits — the slug is gone from .worktrees/ — so the line must carry the next
// step itself.
//
// #239 closed the liveness gap by DECLARATION, not inference. A dispatch locks
// its worktree when it creates it, with a reason naming its role and ticket
// (`git worktree lock .worktrees/<slug> --reason "<role> #<issue>"`), and
// unlocks it before reporting done. Rule 0 keeps any entry git reports as
// `locked`, with the reason printed, BEFORE every other rule and every flag: no
// combination of --force, --include-unstarted, --include-detached or PR history
// reaches a declared-live worktree — and `git worktree remove` refuses a locked
// tree, so the keep states the tool boundary, not a guess about branch state. A
// lock left behind by a crashed dispatch is cleared deliberately, by slug, with
// `--unlock <slug>` (repeatable): unlocking never happens automatically, and an
// --unlock run never sweeps. The sweep itself is gated: a destructive run
// requires --no-active-dispatches. Without it the run prints the verdict lines
// it would print (`would remove <slug> (<reason>)`) and exits non-zero having
// removed nothing, so forgetting the flag destroys nothing; --dry-run needs no
// acknowledgement and still exits 0. The liveness heuristics #239 rejected
// (worktree admin-dir age, file mtimes, HEAD reflog) cannot separate a dispatch
// reattached to a surviving squash-merged branch from deferred cleanup; the
// declaration is the discriminator, and the gate covers the window before a
// dispatch has locked.
//
// Removing merged worktrees by default (rule 1) therefore presumes squash/rebase
// merges, this repo's practice: under a merge-commit or fast-forward merge a
// genuinely merged branch has zero unique commits, so rule 2 keeps it by default
// and it needs --include-unstarted.
//
// Usage: bun scripts/worktree-cleanup.mjs --no-active-dispatches [--dry-run]
//          [--force] [--include-unstarted] [--include-detached]
//        bun scripts/worktree-cleanup.mjs --unlock <slug> [--unlock <slug> ...]
//          [--dry-run]
// Run from the MAIN checkout — a linked worktree has no .worktrees of its own.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");
const includeUnstarted = argv.includes("--include-unstarted");
const includeDetached = argv.includes("--include-detached");
const noActiveDispatches = argv.includes("--no-active-dispatches");

// A run that may destroy requires the operator's acknowledgement; a run that
// only reports (--dry-run) never does. Decided once, here, so no per-entry path
// can forget it.
const refuseSweep = !dryRun && !noActiveDispatches;

// --unlock takes a value and is repeatable, so it is read positionally instead
// of with a presence check.
const unlockSlugs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--unlock") continue;
  const slug = argv[i + 1];
  if (slug === undefined || slug.startsWith("-")) {
    console.error("--unlock requires a slug: --unlock <slug>");
    process.exit(1);
  }
  unlockSlugs.push(slug);
  i++; // the value is consumed, never re-read as a flag
}

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...opts }).trim();
}

function gitOk(args) {
  try {
    execFileSync("git", args, { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

// The PR for a branch, or null when there is none. Both the state and the PR's
// head commit are needed: only a MERGED PR whose head is the branch tip proves
// this exact branch's work reached main.
function ghPr(branch) {
  try {
    const json = execFileSync("gh", ["pr", "view", branch, "--json", "state,headRefOid"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const { state, headRefOid } = JSON.parse(json);
    return { state, headRefOid };
  } catch {
    return null;
  }
}

// The first line of a failed git command's stderr, for a terse per-item reason.
// execFileSync attaches the child's stderr to the thrown error.
function gitError(err) {
  const raw = err?.stderr ? String(err.stderr) : String(err?.message ?? err);
  return raw.trim().split("\n")[0] || "git command failed";
}

function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// `git worktree list --porcelain` prints one block per registered worktree, the
// blocks separated by blank lines: a `worktree <path>` header followed by that
// entry's attributes — one of which may be `locked`, or `locked <reason>`. The
// block structure is what makes the lock readable: a bare `locked` seen while
// walking lines belongs to the entry the last `worktree ` line opened, never to
// the next one. Keyed by realpath, so this map and the `registered` set below
// answer for the same path a `.worktrees/` entry resolves to, symlinks included.
function parseWorktrees(porcelain) {
  const entries = new Map();
  let current = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { locked: false, lockReason: "" };
      entries.set(realOrSelf(line.slice("worktree ".length)), current);
    } else if (current && (line === "locked" || line.startsWith("locked "))) {
      current.locked = true;
      current.lockReason = line.slice("locked".length).trim();
    }
  }
  return entries;
}

const root = git(["rev-parse", "--show-toplevel"]);
const wtRoot = join(root, ".worktrees");

const worktrees = parseWorktrees(git(["worktree", "list", "--porcelain"]));
const registered = new Set(worktrees.keys());

// --unlock <slug> is the deliberate remedy for a declaration left behind by a
// crashed dispatch. It never sweeps and never runs automatically: clearing a
// declaration and destroying the worktree stay two separate, named acts, so an
// unlock can never be the first half of an accidental removal — the closing
// line says so, so an operator who also passed --no-active-dispatches cannot
// read the exit as "the worktree was removed". A dry run stays non-mutating
// here too: it reports intent and validates against git's own listing instead
// of clearing the lock.
function runUnlocks(slugs) {
  let failed = 0;
  for (const slug of slugs) {
    const wt = join(wtRoot, slug);
    if (dryRun) {
      if (worktrees.get(realOrSelf(wt))?.locked) {
        console.log(`would unlock ${slug}`);
      } else {
        console.error(`unlock failed for ${slug}: not a locked worktree`);
        failed++;
      }
      continue;
    }
    try {
      git(["worktree", "unlock", wt]);
      console.log(`unlocked ${slug}`);
    } catch (err) {
      console.error(`unlock failed for ${slug}: ${gitError(err)}`);
      failed++;
    }
  }
  console.log(
    `done: ${slugs.length - failed} unlocked, ${failed} failed — --unlock never sweeps; run again with --no-active-dispatches to remove worktrees`,
  );
  return failed > 0 ? 1 : 0;
}

if (unlockSlugs.length > 0) process.exit(runUnlocks(unlockSlugs));

if (!existsSync(wtRoot)) {
  console.log("No .worktrees directory — nothing to clean.");
  process.exit(0);
}

const base = gitOk(["rev-parse", "--verify", "--quiet", "origin/main"]) ? "origin/main" : "main";

let removed = 0;
let kept = 0;
let wouldRemove = 0;

for (const slug of readdirSync(wtRoot).filter((n) => !n.startsWith("."))) {
  const wt = join(wtRoot, slug);
  const branch = `agent/${slug}`;
  const keep = (msg) => {
    console.log(`kept  ${slug}: ${msg}`);
    kept++;
  };

  // A stray file or directory under .worktrees/ is not ours to delete, and
  // probing it with a git command (cwd=file → ENOTDIR; `worktree remove` →
  // fatal) would abort the whole run. Report it and carry on.
  const realWt = realOrSelf(wt);
  if (!registered.has(realWt)) {
    keep("not a git worktree — remove manually");
    continue;
  }

  // Rule 0, before every rule below and every flag: a lock is a dispatch's own
  // liveness declaration, so it is kept with its reason, and the reason is the
  // operator's evidence of who declared it. `git worktree remove` refuses a
  // locked tree, so consulting branch state first would only invite a doomed
  // removal attempt — and a doomed attempt is a branch-delete risk.
  const worktree = worktrees.get(realWt);
  if (worktree.locked) {
    const reason = worktree.lockReason ? ` ("${worktree.lockReason}")` : "";
    keep(`locked${reason} — a live declaration; clear it with --unlock ${slug}`);
    continue;
  }

  // A registered worktree can still fail every git command aimed at it — a
  // stale gitdir, a permission error. That is this entry's outcome, never the
  // run's: report it and carry on to the remaining slugs.
  let branchExists;
  let dirty;
  let reason;
  try {
    dirty = git(["status", "--porcelain"], { cwd: wt }).length > 0;
    if (dirty && !force) {
      keep("dirty worktree (use --force to discard changes)");
      continue;
    }

    branchExists = gitOk(["rev-parse", "--verify", "--quiet", branch]);

    if (!branchExists) {
      if (!includeDetached) {
        keep(
          `no ${branch} branch — a detached review or in-flight worktree (use --include-detached to remove)`,
        );
        continue;
      }
      reason = `no ${branch} branch`;
    } else {
      const tip = git(["rev-parse", branch]);
      const pr = ghPr(branch);
      const unique = Number(git(["rev-list", "--count", `${base}..${branch}`]));

      // A MERGED PR also needs the branch tip to be that PR's head commit: a
      // re-dispatched slug reuses a merged PR's name. Both conditions plus real
      // commits keep rule 2's guarantee intact — a fresh dispatch at origin/main
      // has zero unique commits even when a fast-forward merge left the old PR's
      // head at the current origin/main tip.
      if (pr?.state === "MERGED" && pr.headRefOid === tip && unique > 0) {
        reason = "PR merged";
      } else if (unique === 0) {
        if (!includeUnstarted) {
          keep(
            `${branch} has no unique commits vs ${base} — either a dispatch that has not committed yet, or work already contained in ${base} (merged with or without a PR); use --include-unstarted to remove`,
          );
          continue;
        }
        reason = `no unique commits vs ${base}`;
      } else if (pr?.state === "MERGED") {
        keep(
          `${branch} has ${unique} commit(s) past its merged PR's head — unmerged work, finish or merge it first`,
        );
        continue;
      } else {
        keep(`${branch} has unmerged work — finish or merge its PR first`);
        continue;
      }
    }
  } catch (err) {
    keep(`failed to inspect (${gitError(err)})`);
    continue;
  }

  // A withheld sweep and a dry run both stop here and print the same verdict
  // line: the report is what the operator gets either way, so the refused run
  // is a truthful preview that happens to exit non-zero.
  if (dryRun || refuseSweep) {
    console.log(`would remove ${slug} (${reason})${dirty ? ", forcing over dirty state" : ""}`);
    if (refuseSweep) wouldRemove++;
    continue;
  }

  // The worktree is removed BEFORE its branch, never the reverse: if the removal
  // fails the worktree still holds `branch`, and deleting it next would destroy
  // the only ref to its commits. Both failures are this entry's outcome, not the
  // run's.
  try {
    git(["worktree", "remove", wt, ...(dirty ? ["--force"] : [])]);
  } catch (err) {
    keep(`failed to remove (${gitError(err)})`);
    continue;
  }
  // Removal succeeded, so this entry IS an entry this tool removed — the
  // worktree, the thing the tool is named for, is gone. A failed branch delete
  // is named in the same line but never demotes it to `kept`: that would
  // contradict what happened and under-count the `done:` line. The surviving
  // branch holds only merged or already-contained work by this point.
  let branchFailure = "";
  if (branchExists) {
    try {
      git(["branch", "-D", branch]);
    } catch (err) {
      branchFailure = `; branch delete failed: ${gitError(err)}`;
    }
  }
  // A failed branch delete is the one failure state no later sweep revisits: the
  // worktree is already gone from .worktrees/, so readdirSync never lists this
  // slug again and the surviving branch waits on a human. The remedy therefore
  // rides this line, the only place it is still named.
  const branchRemedy = branchFailure ? `; delete it with: git branch -D ${branch}` : "";
  console.log(`removed ${slug} (${reason}${branchFailure}${branchRemedy})`);
  removed++;
}

// Fail closed: the operator has not confirmed that no dispatch is active, so
// nothing above was removed. The verdict lines already name what a gated run
// would have done; this line names the flag that turns the preview into the
// sweep, and the non-zero exit is what a script — or a manager's checklist —
// reads.
if (refuseSweep) {
  console.error(
    `refusing to remove ${wouldRemove} worktree${wouldRemove === 1 ? "" : "s"}: pass --no-active-dispatches once you have confirmed no dispatch is active`,
  );
  process.exit(1);
}

console.log(`done: ${removed} removed, ${kept} kept${dryRun ? " (dry run)" : ""}`);
