#!/usr/bin/env bun
// Remove manager-skill subagent worktrees (.worktrees/<slug>) whose branch is
// safely disposable. A branch counts as disposable when ANY of these holds:
//   1. its GitHub PR reports state MERGED (squash-safe — history was rewritten);
//   2. it is an ancestor of origin/main (falling back to local main);
//   3. it has zero unique commits (subagent never committed anything).
// Unmerged work is always KEPT. Dirty worktrees are skipped unless --force.
//
// Usage: bun scripts/worktree-cleanup.mjs [--dry-run] [--force]
// Run from the MAIN checkout — a linked worktree has no .worktrees of its own.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");

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
    return execFileSync(
      "gh",
      ["pr", "view", branch, "--json", "state", "--jq", ".state"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
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

const base = gitOk(["rev-parse", "--verify", "--quiet", "origin/main"])
  ? "origin/main"
  : "main";

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
  let reason = null;
  if (prState === "MERGED") reason = "PR merged";
  else if (gitOk(["merge-base", "--is-ancestor", branch, base]))
    reason = "already in " + base;
  else if (
    gitOk(["rev-parse", "--verify", "--quiet", branch]) &&
    git(["rev-list", "--count", `${base}..${branch}`]) === "0"
  )
    reason = "no unique commits";
  else if (!gitOk(["rev-parse", "--verify", "--quiet", branch]))
    reason = "branch gone";

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
  if (gitOk(["rev-parse", "--verify", "--quiet", branch])) git(["branch", "-D", branch]);
  console.log(`removed ${slug} (${reason})`);
  removed++;
}

console.log(`done: ${removed} removed, ${kept} kept${dryRun ? " (dry run)" : ""}`);
