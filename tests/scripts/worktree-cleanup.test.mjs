import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callLog, git, gitOk, makeFixture, runClean } from "./worktree-cleanup-fixture.mjs";

/**
 * `bun run worktree:clean` — the disposable-worktree rule (#229).
 *
 * Cases and assertions only: the throwaway-repo plumbing — fixture creation,
 * the fake `gh`, `runClean` — lives in `worktree-cleanup-fixture.mjs`. Each
 * case builds its own fixture, so cases share no state.
 *
 * The two cases whose subject is a shared-state surface or the tool's
 * destructive boundary live apart: the real-checkout isolation canary in
 * `worktree-cleanup-isolation.test.mjs`, and the deletion boundary — every
 * deletion printed, every git command inside the run's own root — in
 * `worktree-cleanup-destruction.test.mjs`.
 */

describe("worktree-cleanup", () => {
  it("keeps a zero-commit worktree by default and prints why", () => {
    const fx = makeFixture();
    fx.addUnstarted("unstarted");
    fx.fakeGh({ noPr: ["agent/unstarted"] });

    // The exact pre-fix shape: the branch is an ancestor of origin/main, which
    // the old rule 2 matched and reported as "already in origin/main" before
    // removing it. A dispatch that has not committed yet looks like this.
    expect(gitOk(fx.dir, ["merge-base", "--is-ancestor", "agent/unstarted", "origin/main"])).toBe(
      true,
    );

    const result = runClean(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kept  unstarted");
    expect(result.stdout).toMatch(/no unique commits vs origin\/main/);
    expect(result.stdout).toContain("--include-unstarted");
    expect(result.stdout).toContain("done: 0 removed, 1 kept");
    expect(callLog(fx)).toEqual(["pr view agent/unstarted --json state,headRefOid"]);
    expect(fx.exists("unstarted")).toBe(true);
    expect(fx.branchExists("agent/unstarted")).toBe(true);
    fx.dispose();
  });

  it("removes a zero-commit worktree only with --include-unstarted", () => {
    const fx = makeFixture();
    fx.addUnstarted("unstarted");
    fx.fakeGh({ noPr: ["agent/unstarted"] });

    const result = runClean(fx, ["--include-unstarted"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("removed unstarted (no unique commits vs origin/main)");
    expect(result.stdout).toContain("done: 1 removed, 0 kept");
    expect(fx.exists("unstarted")).toBe(false);
    expect(fx.branchExists("agent/unstarted")).toBe(false);
    fx.dispose();
  });

  it("keeps a branch strictly behind origin/main with zero unique commits (the #229 shape)", () => {
    const fx = makeFixture();
    fx.addUnstarted("behind");
    fx.advanceOrigin();
    fx.fakeGh({ noPr: ["agent/behind"] });

    // The shape that fired in #229: an ancestor of origin/main, not equal to it.
    expect(gitOk(fx.dir, ["merge-base", "--is-ancestor", "agent/behind", "origin/main"])).toBe(
      true,
    );
    expect(git(fx.dir, ["rev-list", "--count", "origin/main..agent/behind"])).toBe("0");

    const result = runClean(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /kept {2}behind: agent\/behind has no unique commits vs origin\/main/,
    );
    expect(result.stdout).toContain("--include-unstarted");
    expect(fx.exists("behind")).toBe(true);

    const swept = runClean(fx, ["--include-unstarted"]);

    expect(swept.status).toBe(0);
    expect(swept.stdout).toContain("removed behind (no unique commits vs origin/main)");
    expect(fx.exists("behind")).toBe(false);
    expect(fx.branchExists("agent/behind")).toBe(false);
    fx.dispose();
  });

  it("does not let a bare --force sweep a zero-commit worktree", () => {
    const fx = makeFixture();
    fx.addUnstarted("forced");
    fx.fakeGh({ noPr: ["agent/forced"] });

    const result = runClean(fx, ["--force"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "kept  forced: agent/forced has no unique commits vs origin/main",
    );
    expect(result.stdout).toContain("done: 0 removed, 1 kept");
    expect(fx.exists("forced")).toBe(true);
    expect(fx.branchExists("agent/forced")).toBe(true);
    fx.dispose();
  });

  it("keeps a detached review worktree by default without consulting gh", () => {
    const fx = makeFixture();
    fx.addDetached("review-7");

    const result = runClean(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kept  review-7");
    expect(result.stdout).toMatch(/no agent\/review-7 branch/);
    expect(result.stdout).toContain("--include-detached");
    expect(result.stdout).toContain("done: 0 removed, 1 kept");
    expect(callLog(fx)).toEqual([]);
    expect(fx.exists("review-7")).toBe(true);
    expect(fx.branchExists("agent/review-7")).toBe(false);
    fx.dispose();
  });

  it("removes a detached review worktree only with --include-detached, without consulting gh", () => {
    const fx = makeFixture();
    fx.addDetached("review-7");

    const result = runClean(fx, ["--include-detached"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("removed review-7 (no agent/review-7 branch)");
    expect(result.stdout).toContain("done: 1 removed, 0 kept");
    expect(callLog(fx)).toEqual([]);
    expect(fx.exists("review-7")).toBe(false);
    fx.dispose();
  });

  it("removes a merged-PR worktree whose PR head is the branch tip", () => {
    const fx = makeFixture();
    const tip = fx.addCommitted("merged");
    fx.fakeGh({ prs: { "agent/merged": { state: "MERGED", headRefOid: tip } } });

    const result = runClean(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("removed merged (PR merged)");
    expect(result.stdout).toContain("done: 1 removed, 0 kept");
    expect(callLog(fx)).toEqual(["pr view agent/merged --json state,headRefOid"]);
    expect(fx.exists("merged")).toBe(false);
    expect(fx.branchExists("agent/merged")).toBe(false);
    fx.dispose();
  });

  it("keeps a re-dispatched slug whose old PR is MERGED (A1: slug reuse)", () => {
    const fx = makeFixture();
    const mergedPrHead = git(fx.dir, ["rev-parse", "HEAD"]);
    fx.advanceOrigin();
    // Re-dispatch: the branch is re-created at the current origin/main, clean
    // and with zero commits — criterion 1's protected state.
    fx.addUnstarted("reused");
    fx.fakeGh({ prs: { "agent/reused": { state: "MERGED", headRefOid: mergedPrHead } } });

    const result = runClean(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "kept  reused: agent/reused has no unique commits vs origin/main",
    );
    expect(result.stdout).toContain("done: 0 removed, 1 kept");
    // The MERGED verdict was consulted and rejected: the PR head is not this
    // branch's tip, so the merged PR is history from an earlier dispatch.
    expect(callLog(fx)).toEqual(["pr view agent/reused --json state,headRefOid"]);
    expect(fx.exists("reused")).toBe(true);
    expect(fx.branchExists("agent/reused")).toBe(true);

    const swept = runClean(fx, ["--include-unstarted"]);

    expect(swept.status).toBe(0);
    expect(swept.stdout).toContain("removed reused (no unique commits vs origin/main)");
    expect(fx.exists("reused")).toBe(false);
    fx.dispose();
  });

  it("keeps a zero-commit slug even when the merged PR's head is the branch tip", () => {
    const fx = makeFixture();
    // A fast-forward merge leaves the merged PR's head at the current
    // origin/main tip, so a re-dispatched slug at origin/main has a tip equal to
    // headRefOid — the one shape the tip check alone cannot separate from a
    // genuinely merged branch. Zero unique commits must still win.
    fx.addUnstarted("ff");
    const tip = git(fx.dir, ["rev-parse", "agent/ff"]);
    fx.fakeGh({ prs: { "agent/ff": { state: "MERGED", headRefOid: tip } } });

    const result = runClean(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kept  ff: agent/ff has no unique commits vs origin/main");
    expect(result.stdout).toContain("--include-unstarted");
    expect(callLog(fx)).toEqual(["pr view agent/ff --json state,headRefOid"]);
    expect(fx.exists("ff")).toBe(true);
    expect(fx.branchExists("agent/ff")).toBe(true);

    const swept = runClean(fx, ["--include-unstarted"]);

    expect(swept.status).toBe(0);
    expect(swept.stdout).toContain("removed ff (no unique commits vs origin/main)");
    expect(fx.exists("ff")).toBe(false);
    fx.dispose();
  });

  it("keeps commits made after a PR merged (A1: unique unpushed work)", () => {
    const fx = makeFixture();
    const tip = fx.addCommitted("stale");
    const mergedPrHead = git(fx.dir, ["rev-parse", "origin/main"]);
    fx.fakeGh({ prs: { "agent/stale": { state: "MERGED", headRefOid: mergedPrHead } } });

    const result = runClean(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /kept {2}stale: agent\/stale has 1 commit\(s\) past its merged PR's head/,
    );
    expect(result.stdout).toContain("done: 0 removed, 1 kept");
    expect(fx.exists("stale")).toBe(true);
    expect(fx.branchExists("agent/stale")).toBe(true);
    expect(git(fx.dir, ["rev-parse", "agent/stale"])).toBe(tip);

    // No flag combination sweeps real unmerged work.
    const swept = runClean(fx, ["--include-unstarted", "--include-detached", "--force"]);

    expect(swept.status).toBe(0);
    expect(swept.stdout).toContain("kept  stale");
    expect(fx.exists("stale")).toBe(true);
    expect(fx.branchExists("agent/stale")).toBe(true);
    fx.dispose();
  });

  it("keeps a CLOSED-without-merge PR's unique commits", () => {
    const fx = makeFixture();
    const tip = fx.addCommitted("closed");
    // headRefOid equals the branch tip here: only the state distinguishes this
    // from the removable merged case.
    fx.fakeGh({ prs: { "agent/closed": { state: "CLOSED", headRefOid: tip } } });

    const result = runClean(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kept  closed: agent/closed has unmerged work");
    expect(fx.exists("closed")).toBe(true);
    expect(fx.branchExists("agent/closed")).toBe(true);
    fx.dispose();
  });

  it("keeps a no-PR worktree with unmerged commits", () => {
    const fx = makeFixture();
    fx.addCommitted("wip");
    fx.fakeGh({ noPr: ["agent/wip"] });

    const result = runClean(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kept  wip: agent/wip has unmerged work");
    expect(callLog(fx)).toEqual(["pr view agent/wip --json state,headRefOid"]);
    expect(fx.exists("wip")).toBe(true);
    expect(fx.branchExists("agent/wip")).toBe(true);
    fx.dispose();
  });

  it("skips a dirty worktree without --force, even with the unstarted flag", () => {
    const fx = makeFixture();
    fx.addUnstarted("dirty");
    fx.fakeGh({ noPr: ["agent/dirty"] });
    writeFileSync(join(fx.wtPath("dirty"), "scratch.txt"), "uncommitted\n");

    const withoutForce = runClean(fx, ["--include-unstarted"]);

    expect(withoutForce.status).toBe(0);
    expect(withoutForce.stdout).toContain("kept  dirty: dirty worktree");
    // Dirty is decided before any gh lookup: no verdict can discard unsaved work.
    expect(callLog(fx)).toEqual([]);
    expect(fx.exists("dirty")).toBe(true);

    const forced = runClean(fx, ["--include-unstarted", "--force"]);

    expect(forced.status).toBe(0);
    expect(forced.stdout).toContain("removed dirty (no unique commits vs origin/main)");
    expect(fx.exists("dirty")).toBe(false);
    fx.dispose();
  });

  it("checks dirty before the MERGED rule: merged-but-dirty waits for --force", () => {
    const fx = makeFixture();
    const tip = fx.addCommitted("dm");
    fx.fakeGh({ prs: { "agent/dm": { state: "MERGED", headRefOid: tip } } });
    writeFileSync(join(fx.wtPath("dm"), "scratch.txt"), "uncommitted\n");

    const result = runClean(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kept  dm: dirty worktree (use --force to discard changes)");
    expect(callLog(fx)).toEqual([]);
    expect(fx.exists("dm")).toBe(true);

    const forced = runClean(fx, ["--force"]);

    expect(forced.status).toBe(0);
    expect(forced.stdout).toContain("removed dm (PR merged)");
    // The forced run is the first to consult gh: with --force the dirty skip is
    // lifted, the MERGED verdict is fetched, and the tip match disposes it.
    expect(callLog(fx)).toEqual(["pr view agent/dm --json state,headRefOid"]);
    expect(fx.exists("dm")).toBe(false);
    expect(fx.branchExists("agent/dm")).toBe(false);
    fx.dispose();
  });

  it("reports stray .worktrees entries instead of aborting the run", () => {
    const fx = makeFixture();
    fx.addUnstarted("real");
    fx.fakeGh({ noPr: ["agent/real"] });
    // Both stray shapes: a file crashed `git status` with ENOTDIR, a directory
    // crashed `git worktree remove` when --include-detached reached it.
    writeFileSync(join(fx.dir, ".worktrees", "README"), "stray\n");
    mkdirSync(join(fx.dir, ".worktrees", "stray-dir"));

    const result = runClean(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kept  README: not a git worktree — remove manually");
    expect(result.stdout).toContain("kept  stray-dir: not a git worktree — remove manually");
    expect(result.stdout).toContain("kept  real: agent/real has no unique commits");
    expect(result.stdout).toContain("done: 0 removed, 3 kept");
    expect(existsSync(join(fx.dir, ".worktrees", "README"))).toBe(true);
    expect(existsSync(join(fx.dir, ".worktrees", "stray-dir"))).toBe(true);
    fx.dispose();
  });

  it("keeps sweeping past stray entries with --include-detached", () => {
    const fx = makeFixture();
    fx.addDetached("review-9");
    writeFileSync(join(fx.dir, ".worktrees", "README"), "stray\n");
    mkdirSync(join(fx.dir, ".worktrees", "stray-dir"));

    const result = runClean(fx, ["--include-detached"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kept  README: not a git worktree — remove manually");
    expect(result.stdout).toContain("kept  stray-dir: not a git worktree — remove manually");
    expect(result.stdout).toContain("removed review-9 (no agent/review-9 branch)");
    expect(result.stdout).toMatch(/^done: 1 removed, 2 kept$/m);
    expect(existsSync(join(fx.dir, ".worktrees", "README"))).toBe(true);
    expect(existsSync(join(fx.dir, ".worktrees", "stray-dir"))).toBe(true);
    expect(fx.exists("review-9")).toBe(false);
    fx.dispose();
  });

  it("keeps a locked worktree instead of aborting, and still sweeps later slugs", () => {
    const fx = makeFixture();
    const lockedTip = fx.addCommitted("a-locked");
    const healthyTip = fx.addCommitted("z-healthy");
    fx.fakeGh({
      prs: {
        "agent/a-locked": { state: "MERGED", headRefOid: lockedTip },
        "agent/z-healthy": { state: "MERGED", headRefOid: healthyTip },
      },
    });
    git(fx.dir, ["worktree", "lock", fx.wtPath("a-locked")]);

    const result = runClean(fx);

    expect(result.status).toBe(0);
    // `git worktree remove` refuses a locked tree: that entry becomes a keep
    // with the git message, not a mid-loop abort.
    expect(result.stdout).toMatch(
      /kept {2}a-locked: failed to remove \(fatal: cannot remove a locked working tree/,
    );
    // The removal failed ⇒ the branch ref is untouched. `git branch -D` here
    // would destroy the only ref the still-present worktree holds.
    expect(fx.exists("a-locked")).toBe(true);
    expect(fx.branchExists("agent/a-locked")).toBe(true);
    // The sweep reached the remaining entry: `done:` prints only after every
    // entry was examined, and the healthy slug was disposed of in the same run.
    // Either assertion fails on a mid-loop abort whatever the readdir order.
    expect(result.stdout).toContain("removed z-healthy (PR merged)");
    expect(result.stdout).toMatch(/^done: 1 removed, 1 kept$/m);
    expect(callLog(fx).sort()).toEqual([
      "pr view agent/a-locked --json state,headRefOid",
      "pr view agent/z-healthy --json state,headRefOid",
    ]);
    fx.dispose();
  });

  it("counts a worktree whose branch delete fails after removal as removed (A6)", () => {
    const fx = makeFixture();
    const tip = fx.addCommitted("half-done");
    fx.fakeGh({ prs: { "agent/half-done": { state: "MERGED", headRefOid: tip } } });
    // The disposal's first step succeeds and its second fails. A stale ref lock
    // is the deterministic trigger: only the delete can fail, and the branch
    // still resolves afterwards.
    fx.refLock("refs/heads/agent/half-done");

    const result = runClean(fx);

    expect(result.status).toBe(0);
    // The line claims only what happened: the removal is reported and the
    // branch failure is named — never a `kept` prefix that contradicts the run.
    // The assertion pins the script-owned prefix only: git's stderr prose past
    // it is a third-party string this repo does not stabilize, so the state
    // assertions below — worktree gone, branch still resolving at its old tip —
    // are what prove this exact path fired.
    expect(result.stdout).toMatch(/^removed half-done \(PR merged; branch delete failed: /m);
    // The remedy is the load-bearing part of the line: no later sweep lists this
    // slug again, so the operator only learns the branch is left from here.
    expect(result.stdout).toContain("delete it with: git branch -D agent/half-done");
    expect(result.stdout).not.toContain("kept  half-done");
    // Summary and per-entry lines agree: this entry was removed, not kept.
    expect(result.stdout).toMatch(/^done: 1 removed, 0 kept$/m);
    expect(fx.exists("half-done")).toBe(false);
    expect(fx.branchExists("agent/half-done")).toBe(true);
    expect(git(fx.dir, ["rev-parse", "agent/half-done"])).toBe(tip);
    fx.dispose();
  });

  it("keeps a stale-gitdir worktree instead of aborting, and still sweeps later slugs", () => {
    const fx = makeFixture();
    const healthyTip = fx.addCommitted("z-healthy");
    fx.addCommitted("a-stale");
    fx.fakeGh({ prs: { "agent/z-healthy": { state: "MERGED", headRefOid: healthyTip } } });
    // Still a registered worktree (its admin dir is intact), but its .git file
    // points at a gitdir that no longer exists: `git status` there exits 128.
    writeFileSync(
      join(fx.wtPath("a-stale"), ".git"),
      `gitdir: ${join(fx.dir, ".git", "worktrees", "gone-gitdir")}\n`,
    );
    expect(git(fx.dir, ["worktree", "list", "--porcelain"])).toContain(fx.wtPath("a-stale"));
    expect(gitOk(fx.wtPath("a-stale"), ["status", "--porcelain"])).toBe(false);

    const result = runClean(fx);

    expect(result.status).toBe(0);
    // The failed inspection is reported per item; the run does not die with an
    // empty stdout and no `done:` line as it did before the guard.
    expect(result.stdout).toMatch(
      /kept {2}a-stale: failed to inspect \(fatal: not a git repository/,
    );
    expect(result.stdout).toContain("kept  a-stale");
    expect(fx.exists("a-stale")).toBe(true);
    expect(fx.branchExists("agent/a-stale")).toBe(true);
    expect(result.stdout).toContain("removed z-healthy (PR merged)");
    expect(result.stdout).toMatch(/^done: 1 removed, 1 kept$/m);
    // The broken entry never reaches the gh consultation: exactly one lookup,
    // for the slug the run went on to dispose of.
    expect(callLog(fx)).toEqual(["pr view agent/z-healthy --json state,headRefOid"]);
    fx.dispose();
  });
});
