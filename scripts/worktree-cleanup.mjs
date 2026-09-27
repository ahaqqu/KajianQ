#!/usr/bin/env bun
// Remove manager-skill subagent worktrees (.worktrees/<slug>) whose work is
// safely disposable: a worktree is removable when ANY of these holds:
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
// cannot abort the run.
//
// Usage: bun scripts/worktree-cleanup.mjs [--dry-run] [--force]
//          [--include-unstarted] [--include-detached]
// Run from the MAIN checkout — a linked worktree has no .worktrees of its own.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const includeUnstarted = process.argv.includes("--include-unstarted");
const includeDetached = process.argv.includes("--include-detached");

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

function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const root = git(["rev-parse", "--show-toplevel"]);
const wtRoot = join(root, ".worktrees");

if (!existsSync(wtRoot)) {
  console.log("No .worktrees directory — nothing to clean.");
  process.exit(0);
}

const base = gitOk(["rev-parse", "--verify", "--quiet", "origin/main"]) ? "origin/main" : "main";
const registered = new Set(
  git(["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => realOrSelf(line.slice("worktree ".length))),
);

let removed = 0;
let kept = 0;

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
  if (!registered.has(realOrSelf(wt))) {
    keep("not a git worktree — remove manually");
    continue;
  }

  const dirty = git(["status", "--porcelain"], { cwd: wt }).length > 0;
  if (dirty && !force) {
    keep("dirty worktree (use --force to discard changes)");
    continue;
  }

  const branchExists = gitOk(["rev-parse", "--verify", "--quiet", branch]);
  let reason = null;

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

  if (dryRun) {
    console.log(`would remove ${slug} (${reason})${dirty ? ", forcing over dirty state" : ""}`);
    continue;
  }

  git(["worktree", "remove", wt, ...(dirty ? ["--force"] : [])]);
  if (branchExists) git(["branch", "-D", branch]);
  console.log(`removed ${slug} (${reason})`);
  removed++;
}

console.log(`done: ${removed} removed, ${kept} kept${dryRun ? " (dry run)" : ""}`);
