import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  callLog,
  git,
  gitOk,
  makeFixture,
  removedSlugs,
  runClean,
} from "./worktree-cleanup-fixture.mjs";

/**
 * `bun run worktree:clean` — the disposable-worktree rule.
 *
 * Cases and assertions only: the throwaway-repo plumbing — fixture creation, the fake
 * `gh`, `runClean` — lives in `worktree-cleanup-fixture.mjs`; each case builds its own
 * fixture, so cases share no state. `runClean` passes the gate acknowledgement unless a
 * case asks it not to. The shared-state canary and the deletion-boundary cases live in
 * `worktree-cleanup-isolation.test.mjs` and `worktree-cleanup-destruction.test.mjs`.
 */

describe("worktree-cleanup", () => {
  it("keeps a zero-commit worktree by default and prints why", () => {
    const fx = makeFixture();
    fx.addUnstarted("unstarted");
    fx.fakeGh({ noPr: ["agent/unstarted"] });

    // An ancestor of origin/main: a dispatch that has not committed yet looks like this.
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
    expect(result.stdout).toMatch(/HEAD is detached/);
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
    expect(result.stdout).toContain("removed review-7 (detached HEAD)");
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

  it("judges the worktree's own branch when its slug and branch disagree", () => {
    const fx = makeFixture();
    const tip = fx.addCommittedOn("agent-15", "agent/router-stages-3-4");
    fx.fakeGh({ prs: { "agent/router-stages-3-4": { state: "MERGED", headRefOid: tip } } });

    const result = runClean(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("removed agent-15 (PR merged)");
    expect(callLog(fx)).toEqual(["pr view agent/router-stages-3-4 --json state,headRefOid"]);
    expect(fx.exists("agent-15")).toBe(false);
    expect(fx.branchExists("agent/router-stages-3-4")).toBe(false);
    fx.dispose();
  });

  it("never judges a branch named after the directory when HEAD is detached", () => {
    const fx = makeFixture();
    // The namesake branch is MERGED but checked out in ANOTHER worktree: judging it
    // would delete a branch this worktree does not hold.
    const outside = fx.addOutside("namesake");
    writeFileSync(join(outside, "wip.txt"), "wip\n");
    git(outside, ["add", "wip.txt"]);
    git(outside, ["commit", "-q", "-m", "wip"]);
    const tip = git(outside, ["rev-parse", "HEAD"]);
    fx.addDetached("namesake");
    fx.fakeGh({ prs: { "agent/namesake": { state: "MERGED", headRefOid: tip } } });

    const result = runClean(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kept  namesake: HEAD is detached");
    expect(result.stdout).toContain("--include-detached");
    expect(callLog(fx)).toEqual([]);
    expect(fx.exists("namesake")).toBe(true);
    expect(fx.branchExists("agent/namesake")).toBe(true);
    fx.dispose();
  });

  it("keeps a re-dispatched slug whose old PR is MERGED (A1: slug reuse)", () => {
    const fx = makeFixture();
    const mergedPrHead = git(fx.dir, ["rev-parse", "HEAD"]);
    fx.advanceOrigin();
    // Re-dispatch: the branch is re-created at the current origin/main with zero commits.
    fx.addUnstarted("reused");
    fx.fakeGh({ prs: { "agent/reused": { state: "MERGED", headRefOid: mergedPrHead } } });

    const result = runClean(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "kept  reused: agent/reused has no unique commits vs origin/main",
    );
    expect(result.stdout).toContain("done: 0 removed, 1 kept");
    // The merged PR is history from an earlier dispatch: its head is not this branch's tip.
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
    // A fast-forward merge leaves the PR's head at the origin/main tip, so the tip
    // check alone cannot separate this shape: zero unique commits must win.
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
    // Only the state distinguishes this from the removable merged case.
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
    // With --force the dirty skip is lifted, so the merged verdict is fetched.
    expect(callLog(fx)).toEqual(["pr view agent/dm --json state,headRefOid"]);
    expect(fx.exists("dm")).toBe(false);
    expect(fx.branchExists("agent/dm")).toBe(false);
    fx.dispose();
  });

  it("reports stray .worktrees entries instead of aborting the run", () => {
    const fx = makeFixture();
    fx.addUnstarted("real");
    fx.fakeGh({ noPr: ["agent/real"] });
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
    expect(result.stdout).toContain("removed review-9 (detached HEAD)");
    expect(result.stdout).toMatch(/^done: 1 removed, 2 kept$/m);
    expect(existsSync(join(fx.dir, ".worktrees", "README"))).toBe(true);
    expect(existsSync(join(fx.dir, ".worktrees", "stray-dir"))).toBe(true);
    expect(fx.exists("review-9")).toBe(false);
    fx.dispose();
  });

  it("keeps a locked worktree instead of aborting, and still sweeps later slugs", () => {
    const fx = makeFixture();
    const healthyTip = fx.addCommitted("z-healthy");
    fx.addCommitted("a-locked");
    // `agent/a-locked` is deliberately undeclared: the lock is checked before rule 1.
    fx.fakeGh({ prs: { "agent/z-healthy": { state: "MERGED", headRefOid: healthyTip } } });
    git(fx.dir, ["worktree", "lock", fx.wtPath("a-locked")]);

    const result = runClean(fx);

    expect(result.status).toBe(0);
    // A lock is the dispatch's own liveness declaration: kept as a declaration
    // (rule 0), never as a failed removal, even with no reason.
    expect(result.stdout).toMatch(
      /kept {2}a-locked: locked — a live declaration; clear it with --unlock a-locked/,
    );
    // Kept ⇒ the branch ref is untouched: `git branch -D` would destroy the only ref.
    expect(fx.exists("a-locked")).toBe(true);
    expect(fx.branchExists("agent/a-locked")).toBe(true);
    // `done:` prints only after every entry was examined, so a mid-loop abort fails
    // either assertion whatever the readdir order.
    expect(result.stdout).toContain("removed z-healthy (PR merged)");
    expect(result.stdout).toMatch(/^done: 1 removed, 1 kept$/m);
    expect(callLog(fx)).toEqual(["pr view agent/z-healthy --json state,headRefOid"]);
    fx.dispose();
  });

  it("counts a worktree whose branch delete fails after removal as removed (A6)", () => {
    const fx = makeFixture();
    const tip = fx.addCommitted("half-done");
    fx.fakeGh({ prs: { "agent/half-done": { state: "MERGED", headRefOid: tip } } });
    // A stale ref lock: only the branch delete can fail, and the branch still resolves.
    fx.refLock("refs/heads/agent/half-done");

    const result = runClean(fx);

    expect(result.status).toBe(0);
    // The assertion pins the script-owned prefix only: git's stderr prose past it is a
    // third-party string this repo does not stabilize, so the state assertions below
    // are what prove the path fired.
    expect(result.stdout).toMatch(/^removed half-done \(PR merged; branch delete failed: /m);
    // The remedy is load-bearing: no later sweep lists this slug again.
    expect(result.stdout).toContain("delete it with: git branch -D agent/half-done");
    expect(result.stdout).not.toContain("kept  half-done");
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
    // Still registered, but its .git file points at a gitdir that no longer exists.
    writeFileSync(
      join(fx.wtPath("a-stale"), ".git"),
      `gitdir: ${join(fx.dir, ".git", "worktrees", "gone-gitdir")}\n`,
    );
    expect(git(fx.dir, ["worktree", "list", "--porcelain"])).toContain(fx.wtPath("a-stale"));
    expect(gitOk(fx.wtPath("a-stale"), ["status", "--porcelain"])).toBe(false);

    const result = runClean(fx);

    expect(result.status).toBe(0);
    // The failed inspection is reported per item; the run keeps going to the other slugs.
    expect(result.stdout).toMatch(
      /kept {2}a-stale: failed to inspect \(fatal: not a git repository/,
    );
    expect(result.stdout).toContain("kept  a-stale");
    expect(fx.exists("a-stale")).toBe(true);
    expect(fx.branchExists("agent/a-stale")).toBe(true);
    expect(result.stdout).toContain("removed z-healthy (PR merged)");
    expect(result.stdout).toMatch(/^done: 1 removed, 1 kept$/m);
    // The broken entry never reaches the gh consultation: exactly one lookup.
    expect(callLog(fx)).toEqual(["pr view agent/z-healthy --json state,headRefOid"]);
    fx.dispose();
  });

  it("keeps a locked worktree with its reason against every destructive flag (#239)", () => {
    const fx = makeFixture();
    const liveTip = fx.addCommitted("live");
    fx.addUnstarted("live-zero");
    fx.addDetached("live-detached");
    // One entry per removal rule, every one declared live: rule 1 with dirty state and
    // --force, rule 2 with --include-unstarted, rule 3 with --include-detached. Nothing
    // is declared to the fixture gh, so a single PR lookup would fail as undeclared.
    writeFileSync(join(fx.wtPath("live"), "scratch.txt"), "uncommitted\n");
    fx.lock("live", "implementer #239");
    fx.lock("live-zero", "senior-implementer #239");
    fx.lock("live-detached", "reviewer #239");

    const result = runClean(fx, ["--force", "--include-unstarted", "--include-detached"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/kept {2}live: locked \("implementer #239"\)/);
    expect(result.stdout).toMatch(/kept {2}live-zero: locked \("senior-implementer #239"\)/);
    expect(result.stdout).toMatch(/kept {2}live-detached: locked \("reviewer #239"\)/);
    expect(result.stdout).toContain("--unlock live");
    expect(result.stdout).toMatch(/^done: 0 removed, 3 kept$/m);
    expect(callLog(fx)).toEqual([]);
    for (const slug of ["live", "live-zero", "live-detached"]) expect(fx.exists(slug)).toBe(true);
    expect(fx.branchExists("agent/live")).toBe(true);
    expect(git(fx.dir, ["rev-parse", "agent/live"])).toBe(liveTip);
    expect(fx.branchExists("agent/live-zero")).toBe(true);
    expect(fx.lockState("live")).toEqual({ locked: true, reason: "implementer #239" });
    expect(fx.lockState("live-detached")).toEqual({
      locked: true,
      reason: "reviewer #239",
    });
    fx.dispose();
  });

  it("sweeps the same entry once its lock is cleared (#239)", () => {
    const fx = makeFixture();
    const tip = fx.addCommitted("live");
    fx.fakeGh({ prs: { "agent/live": { state: "MERGED", headRefOid: tip } } });
    fx.lock("live", "implementer #239");

    const held = runClean(fx);

    expect(held.status).toBe(0);
    expect(held.stdout).toMatch(/kept {2}live: locked \("implementer #239"\)/);
    // The lock short-circuits before rule 1: the declared MERGED verdict was never fetched.
    expect(callLog(fx)).toEqual([]);
    expect(held.stdout).not.toContain("removed live");
    expect(fx.exists("live")).toBe(true);

    fx.unlock("live");
    const swept = runClean(fx);

    expect(swept.status).toBe(0);
    expect(swept.stdout).toContain("removed live (PR merged)");
    expect(swept.stdout).toMatch(/^done: 1 removed, 0 kept$/m);
    expect(callLog(fx)).toEqual(["pr view agent/live --json state,headRefOid"]);
    expect(fx.exists("live")).toBe(false);
    expect(fx.branchExists("agent/live")).toBe(false);
    fx.dispose();
  });

  it("keeps a worktree locked mid-run, after the lock scan, without deleting its branch (#239)", () => {
    const fx = makeFixture();
    const tip = fx.addCommitted("raced");
    fx.fakeGh({
      prs: {
        "agent/raced": {
          state: "MERGED",
          headRefOid: tip,
          // The lock appears after the run's `git worktree list` parse — the one race
          // rule 0 cannot see, so this removal failure must stay a keep and the branch
          // must survive as the surviving worktree's only ref.
          before: `git -C ${fx.dir} worktree lock ${fx.wtPath("raced")} --reason 'dispatch raced'`,
        },
      },
    });

    const result = runClean(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /kept {2}raced: failed to remove \(fatal: cannot remove a locked working tree/,
    );
    expect(fx.exists("raced")).toBe(true);
    expect(fx.branchExists("agent/raced")).toBe(true);
    expect(git(fx.dir, ["rev-parse", "agent/raced"])).toBe(tip);
    expect(fx.lockState("raced")).toEqual({ locked: true, reason: "dispatch raced" });
    fx.dispose();
  });

  it("refuses to remove anything without --no-active-dispatches, and dry-run still exits 0 (#239)", () => {
    const fx = makeFixture();
    const mergedTip = fx.addCommitted("merged");
    fx.addUnstarted("unstarted");
    fx.fakeGh({
      prs: { "agent/merged": { state: "MERGED", headRefOid: mergedTip } },
      noPr: ["agent/unstarted"],
    });
    const verdicts = (stdout) =>
      stdout
        .split("\n")
        .filter((line) => line.startsWith("would remove "))
        .sort();

    const withheld = runClean(fx, ["--include-unstarted"], {}, { withholdGate: true });

    // Fail closed: the operator has not confirmed that no dispatch is active.
    expect(withheld.status).not.toBe(0);
    expect(withheld.stderr).toContain("--no-active-dispatches");
    expect(withheld.stderr).toMatch(/no dispatch is active/);
    // Same verdicts a sweep would act on: the refusal is a preview, with no `done:` line.
    expect(verdicts(withheld.stdout)).toEqual([
      "would remove merged (PR merged)",
      "would remove unstarted (no unique commits vs origin/main)",
    ]);
    expect(removedSlugs(withheld.stdout)).toEqual([]);
    expect(withheld.stdout).not.toContain("done:");
    expect(fx.exists("merged")).toBe(true);
    expect(fx.exists("unstarted")).toBe(true);
    expect(fx.branchExists("agent/merged")).toBe(true);
    expect(fx.branchExists("agent/unstarted")).toBe(true);

    const preview = runClean(fx, ["--include-unstarted", "--dry-run"], {}, { withholdGate: true });

    expect(preview.status).toBe(0);
    expect(verdicts(preview.stdout)).toEqual(verdicts(withheld.stdout));
    expect(preview.stdout).toContain("done: 0 removed, 0 kept (dry run)");
    expect(fx.exists("merged")).toBe(true);

    const swept = runClean(fx, ["--include-unstarted"]);

    expect(swept.status).toBe(0);
    expect(swept.stdout).toContain("done: 2 removed, 0 kept");
    expect(fx.exists("merged")).toBe(false);
    expect(fx.exists("unstarted")).toBe(false);
    fx.dispose();
  });

  it("a gated run with nothing to remove says so and exits 0, while a withheld removal still refuses (#257 A2)", () => {
    const fx = makeFixture();
    fx.addCommitted("live");
    fx.addUnstarted("unstarted");
    fx.fakeGh({ noPr: ["agent/unstarted"] });
    fx.lock("live", "implementer #257");

    // Both entries are kept by default — locked (rule 0) and unstarted (rule 2): zero
    // candidates, nothing withheld.
    const nothing = runClean(fx, [], {}, { withholdGate: true });

    expect(nothing.status).toBe(0);
    expect(nothing.stderr).toBe("");
    expect(nothing.stdout).toContain(
      "nothing to remove: --no-active-dispatches is only needed when there is something to remove",
    );
    expect(nothing.stdout).not.toContain("refusing to remove");
    expect(nothing.stdout).not.toContain("would remove");
    expect(nothing.stdout).toContain("done: 0 removed, 2 kept");
    expect(removedSlugs(nothing.stdout)).toEqual([]);
    expect(fx.lockState("live")).toEqual({ locked: true, reason: "implementer #257" });
    expect(fx.exists("unstarted")).toBe(true);
    expect(fx.branchExists("agent/unstarted")).toBe(true);

    // The same fixture with one candidate is a real withheld removal and keeps the
    // refusal.
    const withheld = runClean(fx, ["--include-unstarted"], {}, { withholdGate: true });

    expect(withheld.status).not.toBe(0);
    expect(withheld.stdout).toContain("would remove unstarted (no unique commits vs origin/main)");
    expect(withheld.stderr).toContain(
      "refusing to remove 1 worktree: pass --no-active-dispatches once you have confirmed no dispatch is active",
    );
    expect(withheld.stderr).not.toContain("nothing to remove");
    expect(withheld.stdout).not.toContain("nothing to remove");
    expect(withheld.stdout).not.toContain("done:");
    expect(fx.exists("unstarted")).toBe(true);
    expect(fx.branchExists("agent/unstarted")).toBe(true);
    fx.dispose();
  });

  it("--unlock clears only the named lock, repeatably, and never sweeps (#239)", () => {
    const fx = makeFixture();
    const mergedTip = fx.addCommitted("one");
    fx.addCommitted("two");
    fx.addCommitted("three");
    // `one` is the shape a sweep would remove, so "nothing was removed" is evidence
    // about the mode rather than the entry's state.
    fx.fakeGh({ prs: { "agent/one": { state: "MERGED", headRefOid: mergedTip } } });
    fx.lock("one", "implementer #239");
    fx.lock("two", "fixer #239");
    fx.lock("three", "reviewer #239");

    // An --unlock run needs no gate: it destroys nothing and exits before the sweep.
    const partial = runClean(fx, ["--unlock", "one"], {}, { withholdGate: true });

    expect(partial.status).toBe(0);
    expect(partial.stdout).toContain("unlocked one");
    expect(partial.stdout).not.toContain("unlocked two");
    expect(partial.stdout).toContain("--unlock never sweeps");
    expect(fx.lockState("one")).toEqual({ locked: false, reason: "" });
    expect(fx.lockState("two")).toEqual({ locked: true, reason: "fixer #239" });
    // No sweep ran: removing `one` would have required its gh verdict, and no lookup
    // was made.
    expect(callLog(fx)).toEqual([]);
    expect(removedSlugs(partial.stdout)).toEqual([]);
    expect(fx.exists("one")).toBe(true);
    expect(fx.branchExists("agent/one")).toBe(true);

    // Repeatable, and only the named entries.
    const rest = runClean(fx, ["--unlock", "two", "--unlock", "three"], {}, { withholdGate: true });

    expect(rest.status).toBe(0);
    expect(rest.stdout).toContain("unlocked two");
    expect(rest.stdout).toContain("unlocked three");
    expect(fx.lockState("two").locked).toBe(false);
    expect(fx.lockState("three").locked).toBe(false);
    expect(fx.exists("two")).toBe(true);
    expect(fx.exists("three")).toBe(true);
    expect(callLog(fx)).toEqual([]);
    fx.dispose();
  });

  it("--unlock fails visibly for an unknown slug or a slug that is not locked (#239)", () => {
    const fx = makeFixture();
    fx.addCommitted("plain");
    fx.lock("plain", "implementer #239");
    fx.unlock("plain"); // registered, but its declaration is already cleared

    const unknown = runClean(fx, ["--unlock", "no-such-slug"], {}, { withholdGate: true });

    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toMatch(/unlock failed for no-such-slug: /);
    expect(fx.exists("no-such-slug")).toBe(false);

    const notLocked = runClean(fx, ["--unlock", "plain"], {}, { withholdGate: true });

    expect(notLocked.status).not.toBe(0);
    expect(notLocked.stderr).toMatch(/unlock failed for plain: /);
    // The failure is the run's, not a partial mutation: entry and branch untouched.
    expect(fx.exists("plain")).toBe(true);
    expect(fx.branchExists("agent/plain")).toBe(true);

    // A missing value is its own loud failure, never a silent no-op.
    const missing = runClean(fx, ["--unlock"], {}, { withholdGate: true });

    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("--unlock requires a slug");
    expect(callLog(fx)).toEqual([]);
    fx.dispose();
  });

  it("--unlock refuses a slug that escapes .worktrees/, leaving an out-of-tree lock standing (#257 A1)", () => {
    const fx = makeFixture();
    fx.addCommitted("in-tree");
    fx.lock("in-tree", "fixer #257");
    // A registered, locked worktree outside .worktrees/ — a sibling of the tool's own
    // root: git knows it, the tool's scope does not.
    const outside = fx.addOutside("elsewhere");
    fx.lockAt(outside, "implementer #999");

    for (const escape of ["../elsewhere", "nested/slug", ".", ".."]) {
      const trace = join(fx.dir, `git-trace-${escape.replace(/\W/g, "_")}.json`);
      const result = runClean(
        fx,
        ["--unlock", escape],
        { GIT_TRACE2_EVENT: trace },
        { withholdGate: true },
      );

      // Refused in the argument-parse loop, in the same loud shape a missing value
      // gets, with no git call at all — so git never wrote its trace.
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `--unlock requires a slug within .worktrees/: "${escape}" is not a bare directory name`,
      );
      expect(result.stdout).toBe("");
      expect(existsSync(trace)).toBe(false);

      // The declaration the escape aimed at survives, read from git's own listing.
      expect(fx.lockStateAt(outside)).toEqual({ locked: true, reason: "implementer #999" });
      expect(existsSync(outside)).toBe(true);
      expect(fx.lockState("in-tree")).toEqual({ locked: true, reason: "fixer #257" });
    }

    // Every legitimate slug shape still unlocks: a kebab slug, a detached `review-<pr>`,
    // and an interior dot — one component under .worktrees/ is all the rule requires.
    fx.addDetached("review-257");
    fx.lock("review-257", "reviewer #257");
    fx.addCommitted("v1.2-fix");
    fx.lock("v1.2-fix", "implementer #257");

    const legit = runClean(
      fx,
      ["--unlock", "in-tree", "--unlock", "review-257", "--unlock", "v1.2-fix"],
      {},
      { withholdGate: true },
    );

    expect(legit.status).toBe(0);
    expect(legit.stdout).toContain("done: 3 unlocked, 0 failed");
    expect(fx.lockState("in-tree")).toEqual({ locked: false, reason: "" });
    expect(fx.lockState("review-257")).toEqual({ locked: false, reason: "" });
    expect(fx.lockState("v1.2-fix")).toEqual({ locked: false, reason: "" });
    // Neither mode sweeps: an --unlock run consults no PR history.
    expect(callLog(fx)).toEqual([]);
    fx.dispose();
  });

  it("--dry-run --unlock reports without clearing the lock (#239)", () => {
    const fx = makeFixture();
    fx.addCommitted("live");
    fx.lock("live", "implementer #239");

    const preview = runClean(fx, ["--unlock", "live", "--dry-run"], {}, { withholdGate: true });

    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("would unlock live");
    // Clearing a declaration is a change, so a dry run leaves the lock in place.
    expect(fx.lockState("live")).toEqual({ locked: true, reason: "implementer #239" });
    expect(fx.exists("live")).toBe(true);
    expect(callLog(fx)).toEqual([]);
    fx.dispose();
  });
});
