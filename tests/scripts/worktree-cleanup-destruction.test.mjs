import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  gitCommands,
  makeFixture,
  removedSlugs,
  runClean,
  SCRIPT,
  summaryCounts,
} from "./worktree-cleanup-fixture.mjs";

/**
 * The deletion boundary of `bun run worktree:clean` (#246, A1): this run may
 * only delete what it names, and only inside its own root.
 *
 * This is where the destruction tripwire lives now. It used to be the last
 * assertion of the isolation case — a superset comparison of the real
 * `.worktrees/` listing — which flaked on a concurrent REMOVAL of a real entry
 * (a finishing dispatch's or a reviewer's own cleanup) and sent an operator
 * triaging red toward a leak. The invariant is observed here at git's own
 * boundary instead: every git command this run issues is in its trace
 * (`GIT_TRACE2_EVENT`), and nothing in that trace can be moved by another
 * process. It is also strictly wider than the listing check was: a branch ref
 * deleted in the real checkout never shrinks the listing.
 *
 * Kept in its own case and its own file so a failure names the right
 * suspicion (A1/B2): not "the root resolution leaked", but "the run deleted
 * something it did not print, or reached outside its root".
 */

describe("worktree-cleanup destruction boundary", () => {
  it("prints every deletion it performs, and deletes only inside its own root", () => {
    const fx = makeFixture();
    const mergedTip = fx.addCommitted("merged");
    fx.addUnstarted("unstarted");
    fx.addDetached("review-7");
    fx.fakeGh({
      prs: { "agent/merged": { state: "MERGED", headRefOid: mergedTip } },
      noPr: ["agent/unstarted"],
    });
    // A stray entry the run keeps and never removes: keeps are printed but are
    // not deletions, so the accounting below cannot pass by printing and
    // deleting the same set of entries.
    writeFileSync(join(fx.dir, ".worktrees", "README"), "stray\n");
    const trace = join(fx.dir, "git-trace.json");

    // All three removal rules in one run: rule 1 (merged PR), rule 2
    // (--include-unstarted), rule 3 (--include-detached, no branch to delete).
    const result = runClean(fx, ["--include-unstarted", "--include-detached"], {
      GIT_TRACE2_EVENT: trace,
    });

    expect(result.status).toBe(0);
    const done = summaryCounts(result.stdout);
    expect(done).toEqual({ removed: 3, kept: 1 });
    for (const slug of ["merged", "unstarted", "review-7"]) expect(fx.exists(slug)).toBe(false);
    expect(existsSync(join(fx.dir, ".worktrees", "README"))).toBe(true);

    // Every git command the run issued, from this run's own trace. The script's
    // deletion primitives are git-only (pinned at the bottom), so these are
    // every deletion the tool can perform — no shared directory sampled.
    const commands = gitCommands(trace);
    const removals = commands.filter((c) => c.args[0] === "worktree" && c.args[1] === "remove");
    const branchDeletes = commands.filter((c) => c.args[0] === "branch" && c.args[1] === "-D");
    // Non-vacuity: all three rules really removed a worktree, and both
    // branch-bearing entries really deleted their branch.
    expect(removals.map((c) => basename(c.args[2])).sort()).toEqual([
      "merged",
      "review-7",
      "unstarted",
    ]);
    expect(branchDeletes.map((c) => c.args[2]).sort()).toEqual(["agent/merged", "agent/unstarted"]);

    // The print invariant: every deletion is named by exactly one `removed
    // <slug>` line and counted by the run's own summary. A path that deletes
    // without printing — the one shape the real-listing superset check uniquely
    // owned — fails here deterministically.
    expect(removedSlugs(result.stdout).sort()).toEqual(["merged", "review-7", "unstarted"]);
    expect(removedSlugs(result.stdout)).toHaveLength(done.removed);
    expect(removals).toHaveLength(done.removed);

    // Nothing ran outside the run's own root: every absolute path the run
    // passed to git, and every repository git discovered for it, sits inside
    // the fixture. A run that changed directory into the real checkout, or
    // addressed it by path, is caught here whatever it printed.
    const inside = (path) => path === fx.dir || path.startsWith(`${fx.dir}/`);
    expect([
      ...commands.flatMap((c) => c.args.filter((arg) => arg.startsWith("/") && !inside(arg))),
      ...commands.map((c) => c.repo).filter((repo) => repo !== null && !inside(repo)),
    ]).toEqual([]);

    // Deletion primitives are git-only, which is what lets the trace above be
    // read as "every deletion": a filesystem removal would escape git's
    // boundary and the print accounting with it, so its arrival fails here.
    expect(readFileSync(SCRIPT, "utf8")).not.toMatch(
      /\b(?:rm|rmdir|unlink|rmSync|rmdirSync|unlinkSync)\s*\(/,
    );
    fx.dispose();
  });
});
