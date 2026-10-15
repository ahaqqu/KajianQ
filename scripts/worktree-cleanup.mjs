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
//   3. its HEAD is detached — a review checkout, or one orphaned by an earlier
//      sweep — AND --include-detached was passed.
// The branch a worktree is judged by is the one its own HEAD has checked out
// (`git worktree list --porcelain`'s `branch` line), never a name derived from
// its directory: a derived name would miss merged work and risk deleting a branch
// the worktree is not on. No branch line is a detached HEAD, which is rule 3.
// Rules 2 and 3 are KEPT by default: with no commits or no branch, "abandoned"
// and "a dispatch or review still in flight" are indistinguishable, and that
// worktree is the most expensive to lose and the cheapest to sweep later. Rule 2
// also covers a branch already contained in main — merged there without a PR, or
// fast-forward-merged with one. Rule 2 outranks rule 1, so a default run never
// removes a zero-unique-commit worktree whatever PR history says about its name.
// Branches with unmerged commits are always KEPT; dirty ones need --force.
//
// Rule 0 keeps any entry git reports as `locked`, with its reason printed, BEFORE
// every other rule and every flag: a dispatch declares itself live by locking its
// worktree when it creates it, and `git worktree remove` refuses a locked tree. A
// lock left behind by a crashed dispatch is cleared deliberately, by slug, with
// `--unlock <slug>` (repeatable) — a bare name under .worktrees/, refused before
// any git call; unlocking is never automatic, and an --unlock run never sweeps.
//
// A `.worktrees/` entry that is not a registered git worktree is reported and
// skipped, never removed, so one stray entry cannot abort the run. An entry whose
// worktree removal succeeds but whose branch delete then fails is still counted as
// removed, with the failure and the manual remedy (`git branch -D`) named in the
// same line.
//
// The sweep is gated: a destructive run requires --no-active-dispatches, which
// covers the window before a dispatch has locked. Without it every removal a sweep
// would make is withheld, the verdict lines are printed, no summary line, and the
// run exits non-zero having removed nothing; a gated run with nothing to remove
// withholds nothing, so it says so and exits 0. --dry-run needs no acknowledgement.
//
// Removing merged worktrees by default (rule 1) therefore presumes squash/rebase
// merges, this repo's practice: under a merge-commit or fast-forward merge a merged
// branch has zero unique commits, so rule 2 keeps it by default.
//
// Usage: bun scripts/worktree-cleanup.mjs --no-active-dispatches [--dry-run]
//          [--force] [--include-unstarted] [--include-detached]
//        bun scripts/worktree-cleanup.mjs --unlock <slug> [--unlock <slug> ...] [--dry-run]
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

// Decided once, so no per-entry path can forget the gate.
const refuseSweep = !dryRun && !noActiveDispatches;

// --unlock takes a value and is repeatable, so it is read positionally rather than
// by presence check. The value must be one bare directory name: a slug with a
// separator or a `.`/`..` segment would reach a registered worktree outside
// .worktrees/, so it is refused here, before any git call.
function isBareSlug(slug) {
  return !slug.includes("/") && slug !== "." && slug !== "..";
}

const unlockSlugs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--unlock") continue;
  const slug = argv[i + 1];
  if (slug === undefined || slug.startsWith("-")) {
    console.error("--unlock requires a slug: --unlock <slug>");
    process.exit(1);
  }
  if (!isBareSlug(slug)) {
    console.error(
      `--unlock requires a slug within .worktrees/: "${slug}" is not a bare directory name (no "/", not "." or "..")`,
    );
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

// The PR for a branch, or null when there is none. Only a MERGED PR whose head is
// the branch tip proves this exact branch's work reached main.
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

// The failed command's stderr first line; execFileSync attaches it to the error.
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

// `git worktree list --porcelain` prints one blank-line-separated block per
// registered worktree: a `worktree <path>` header, then that entry's attributes —
// one of which may be `locked <reason>`, belonging to the last `worktree ` line.
// Keyed by realpath, so this map and the `registered` set answer for the same path.
function parseWorktrees(porcelain) {
  const entries = new Map();
  let current = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { locked: false, lockReason: "", branch: undefined };
      entries.set(realOrSelf(line.slice("worktree ".length)), current);
    } else if (current && line.startsWith("branch refs/heads/")) {
      // A detached HEAD prints no `branch` line at all.
      current.branch = line.slice("branch refs/heads/".length);
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
// crashed dispatch: clearing a declaration and destroying the worktree stay two
// separate, named acts, and a dry run only reports intent.
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
  const keep = (msg) => {
    console.log(`kept  ${slug}: ${msg}`);
    kept++;
  };

  // A stray file or directory under .worktrees/ is not ours to delete, and probing
  // it with a git command would abort the run (cwd=file → ENOTDIR), so it is skipped.
  const realWt = realOrSelf(wt);
  if (!registered.has(realWt)) {
    keep("not a git worktree — remove manually");
    continue;
  }

  // Rule 0, before every rule below and every flag: `git worktree remove` refuses
  // a locked tree, so consulting branch state first would only invite a doomed
  // removal attempt — and a doomed attempt is a branch-delete risk.
  const worktree = worktrees.get(realWt);
  if (worktree.locked) {
    const reason = worktree.lockReason ? ` ("${worktree.lockReason}")` : "";
    keep(`locked${reason} — a live declaration; clear it with --unlock ${slug}`);
    continue;
  }

  // Never a name derived from the directory; no `branch` line means detached HEAD.
  const branch = worktree.branch;

  // A registered worktree can still fail every git command aimed at it (a stale
  // gitdir, a permission error): that is this entry's outcome, never the run's.
  let branchExists;
  let dirty;
  let reason;
  try {
    dirty = git(["status", "--porcelain"], { cwd: wt }).length > 0;
    if (dirty && !force) {
      keep("dirty worktree (use --force to discard changes)");
      continue;
    }

    branchExists = branch !== undefined;

    if (!branchExists) {
      if (!includeDetached) {
        keep(
          "HEAD is detached — a review checkout or an in-flight worktree (use --include-detached to remove)",
        );
        continue;
      }
      reason = "detached HEAD";
    } else {
      const tip = git(["rev-parse", branch]);
      const pr = ghPr(branch);
      const unique = Number(git(["rev-list", "--count", `${base}..${branch}`]));

      // A MERGED PR also needs the branch tip to be that PR's head commit, and
      // real commits: a fresh dispatch at origin/main has zero unique commits even
      // when a fast-forward merge left the old PR's head at the current origin/main
      // tip.
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

  // A dry run and a withheld sweep print the same verdict line; the latter exits
  // non-zero.
  if (dryRun || refuseSweep) {
    console.log(`would remove ${slug} (${reason})${dirty ? ", forcing over dirty state" : ""}`);
    if (refuseSweep) wouldRemove++;
    continue;
  }

  // The worktree is removed BEFORE its branch, never the reverse: if the removal
  // fails the worktree still holds `branch`, and deleting it next would destroy
  // the only ref to its commits. A failure here is this entry's, not the run's.
  try {
    git(["worktree", "remove", wt, ...(dirty ? ["--force"] : [])]);
  } catch (err) {
    keep(`failed to remove (${gitError(err)})`);
    continue;
  }
  // Removal succeeded, so this entry IS removed: a failed branch delete is named in
  // the same line but never demotes it to `kept`, which would contradict the run.
  let branchFailure = "";
  if (branchExists) {
    try {
      git(["branch", "-D", branch]);
    } catch (err) {
      branchFailure = `; branch delete failed: ${gitError(err)}`;
    }
  }
  // No later sweep revisits a failed branch delete — the worktree is already gone
  // from .worktrees/ — so the remedy rides this line, the only place it is named.
  const branchRemedy = branchFailure ? `; delete it with: git branch -D ${branch}` : "";
  console.log(`removed ${slug} (${reason}${branchFailure}${branchRemedy})`);
  removed++;
}

// Fail closed, but only where something was actually withheld: an entry a sweep
// would have removed is withheld and the run exits non-zero.
if (refuseSweep && wouldRemove > 0) {
  console.error(
    `refusing to remove ${wouldRemove} worktree${wouldRemove === 1 ? "" : "s"}: pass --no-active-dispatches once you have confirmed no dispatch is active`,
  );
  process.exit(1);
}

// Zero candidates is the one gated shape that withheld nothing, so it is not a
// refusal: it says so and exits 0 like any other no-op.
if (refuseSweep) {
  console.log(
    "nothing to remove: --no-active-dispatches is only needed when there is something to remove",
  );
}

console.log(`done: ${removed} removed, ${kept} kept${dryRun ? " (dry run)" : ""}`);
