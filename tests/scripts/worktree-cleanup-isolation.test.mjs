import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  callLog,
  gitOk,
  MAIN_ROOT,
  makeFixture,
  namedSlugs,
  REAL_WORKTREES,
  runClean,
  summaryCounts,
} from "./worktree-cleanup-fixture.mjs";

/**
 * The real-checkout isolation canary for `bun run worktree:clean` (#246),
 * split out of `worktree-cleanup.test.mjs` because it is the one case whose
 * subject is a surface other agents mutate: the real `.worktrees/` listing.
 *
 * The leak signal is the run's own output: a run rooted at the fixture never
 * sees the real checkout, so the entries it names are the fixture's own two and
 * nothing else. That signal cannot race — no other process can change what this
 * run printed — unlike a snapshot comparison of the shared listing.
 *
 * It deliberately does NOT compare the real listing before and after. The
 * superset check that used to live here (A1) flaked on a concurrent REMOVAL of
 * a real entry — a finishing dispatch's or a reviewer's own cleanup, which this
 * repo's parallel workflow produces routinely: 7/30 runs failed under a 0.12 s
 * create/remove churn. Destructive coverage moved to
 * `worktree-cleanup-destruction.test.mjs`, which audits the commands the run
 * issues at git's own boundary: no shared state, and it also catches deletions
 * the listing never shows (a branch ref, an unprinted removal).
 */

// The fixture slug this case uses. Deliberately one no dispatch would pick, so
// finding it in the real checkout is unambiguous evidence of a leak.
const SLUG = "isolation-canary";

describe("worktree-cleanup isolation", () => {
  it("resolves its root from the fixture repo, never the real checkout", () => {
    // Read before the run only for the defense-in-depth lookup check below;
    // nothing here compares it afterwards.
    const realBefore = existsSync(REAL_WORKTREES) ? readdirSync(REAL_WORKTREES) : [];
    const fx = makeFixture();
    fx.addUnstarted(SLUG);
    fx.fakeGh({ noPr: [`agent/${SLUG}`] });
    // A stray entry the run reports and never removes: it makes the run print
    // both line shapes the named-slug assertion parses — `kept <slug>:` and
    // `removed <slug> (` — so the parse is exercised, not just one shape.
    writeFileSync(join(fx.dir, ".worktrees", "README"), "stray\n");

    // The premise of the materialization tripwire at the bottom, asserted
    // before the run: the slug is unique to this case, so its absence
    // afterwards would prove nothing if it was already there.
    expect(realBefore).not.toContain(SLUG);
    expect(gitOk(MAIN_ROOT, ["rev-parse", "--verify", "--quiet", `agent/${SLUG}`])).toBe(false);

    const result = runClean(fx, ["--include-unstarted"]);

    expect(result.status).toBe(0);
    // The script acted on the fixture's own worktree — proof it resolved the
    // fixture root, not the real checkout.
    expect(result.stdout).toContain(`removed ${SLUG} (no unique commits vs origin/main)`);
    expect(fx.exists(SLUG)).toBe(false);
    // The parse is accountable before it is trusted (A2): the number of
    // per-entry lines parsed equals the run's own totals, so a future line
    // shape this closed prefix set does not know reddens the case here — as a
    // parser gap — instead of silently shrinking what the leak assertion below
    // pins. (A leak still passes this one: a leaked run's own totals match its
    // own lines; the assertion below is what names it.)
    const done = summaryCounts(result.stdout);
    expect(namedSlugs(result.stdout)).toHaveLength(done.removed + done.kept);
    // The leak tested directly: a run that resolved the real checkout
    // enumerates and names the real slugs, whatever a concurrent dispatch
    // created or removed while it ran. Every entry the run examined is pinned,
    // so a leak cannot hide behind the shapes that happen to pass. Not vacuous:
    // an early exit that named nothing would fail this too.
    expect(namedSlugs(result.stdout).sort()).toEqual(["README", SLUG]);
    // Only that one lookup happened: a root-resolution leak would have produced
    // a gh call per real slug, and this log has no other line.
    expect(callLog(fx)).toEqual([`pr view agent/${SLUG} --json state,headRefOid`]);
    // Exact-line defense in depth on top of that equality: kept exact so a real
    // slug cannot match as a substring of the fixture's one lookup.
    for (const slug of realBefore) {
      expect(callLog(fx)).not.toContain(`pr view agent/${slug} --json state,headRefOid`);
    }
    // Materialization tripwire, and only that. The script has no create path —
    // it removes worktrees and branches, never makes them — so this pair cannot
    // fail for a root-resolution bug: absence holds whether or not the
    // destructive path ran against the real checkout, and a full leak passes it
    // (the leak is caught by the assertions above instead). What it does pin is
    // unambiguous when it fires: this case's own slug materialised as a real
    // worktree or branch, which nothing in this repo does.
    expect(existsSync(join(REAL_WORKTREES, SLUG))).toBe(false);
    expect(gitOk(MAIN_ROOT, ["rev-parse", "--verify", "--quiet", `agent/${SLUG}`])).toBe(false);
    fx.dispose();
  });
});
