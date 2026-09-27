#!/usr/bin/env bun
// Remove manager-skill subagent worktrees (.worktrees/<slug>) whose work is
// safely disposable: a worktree is removable when ANY of these holds:
//   1. its GitHub PR reports state MERGED (squash-safe — history was rewritten);
//   2. it has no unique commits vs origin/main (falling back to local main),
//      AND --include-unstarted was passed;
//   3. it has no agent/<slug> branch — a detached review checkout, or one
//      orphaned by an earlier sweep — AND --include-detached was passed.
// Rules 2 and 3 are KEPT by default with the reason printed: with no commits or
// no branch, "abandoned" and "a dispatch or review still in flight" are
// indistinguishable, and that worktree is the most expensive to lose and the
// cheapest to sweep later. Branches with unmerged commits are always KEPT.
// Dirty worktrees are skipped unless --force.
//
// Usage: bun scripts/worktree-cleanup.mjs [--dry-run] [--force]
//          [--include-unstarted] [--include-detached]
// Run from the MAIN checkout — a linked worktree has no .worktrees of its own.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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

function ghPrState(branch) {
  try {
    return execFileSync("gh", ["pr", "view", branch, "--json", "state", "--jq", ".state"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const root = git(["rev-parse", "--show-toplevel"]);
const wtRoot = join(root, ".worktrees");

if (!existsSync(wtRoot)) {
  console.log("No .worktrees directory — nothing to clean.");
  process.exit(0);
}

const base = gitOk(["rev-parse", "--verify", "--quiet", "origin/main"]) ? "origin/main" : "main";

let removed = 0;
let kept = 0;

for (const slug of readdirSync(wtRoot).filter((n) => !n.startsWith("."))) {
  const wt = join(wtRoot, slug);
  const branch = `agent/${slug}`;

  const dirty = git(["status", "--porcelain"], { cwd: wt }).length > 0;
  if (dirty && !force) {
    console.log(`kept  ${slug}: dirty worktree (use --force to discard changes)`);
    kept++;
    continue;
  }

  const prState = ghPrState(branch);
  const branchExists = gitOk(["rev-parse", "--verify", "--quiet", branch]);
  let reason = null;

  if (prState === "MERGED") {
    reason = "PR merged";
  } else if (!branchExists) {
    if (!includeDetached) {
      console.log(
        `kept  ${slug}: no ${branch} branch — a detached review or in-flight worktree (use --include-detached to remove)`,
      );
      kept++;
      continue;
    }
    reason = `no ${branch} branch`;
  } else if (git(["rev-list", "--count", `${base}..${branch}`]) === "0") {
    if (!includeUnstarted) {
      console.log(
        `kept  ${slug}: ${branch} has no unique commits vs ${base} — an in-flight dispatch may not have committed yet (use --include-unstarted to remove)`,
      );
      kept++;
      continue;
    }
    reason = `no unique commits vs ${base}`;
  }

  if (!reason) {
    console.log(`kept  ${slug}: ${branch} has unmerged work — finish or merge its PR first`);
    kept++;
    continue;
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
