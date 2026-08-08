import { writeFileSync } from "node:fs";
import {
  assertCleanWorktree,
  ensureRemote,
  fetchUpstream,
  isTemplateRepo,
  redactUrl,
  resolveCommit,
  resolveRef,
} from "./git.mjs";
import { isOverwritePath } from "./manifest.mjs";
import { clearPending, readPending } from "./state.mjs";
import { baseline, commitState, drift, stageState, validateFlag } from "./sync.mjs";

const DEFAULT_SYNC_BRANCH = "template-sync";
const PENDING_FILE = ".template-sync.pending";

export function createCommands(ctx) {
  const { cwd, log, git, gitOk, gitOut, remote, manifest, env, state } = ctx;
  const statePath = `${cwd}/.template-sync.state`;
  const pendingPath = `${cwd}/${PENDING_FILE}`;
  const syncCtx = { git, gitOk, gitOut, remote, log, manifest, statePath, state };

  const cmdInit = () => {
    if (isTemplateRepo({ gitOut, remote, manifest, env })) {
      log.info("template repo detected; nothing to init");
      return 0;
    }
    ensureRemote({ git, gitOk, gitOut, remote, log, manifest, env });
    fetchUpstream({ git, remote, log });
    log.info("upstream fetched", {
      upstream: redactUrl(manifest.upstream),
      next: "bun run template-sync update",
    });
    return 0;
  };

  const cmdCheck = () => {
    if (isTemplateRepo({ gitOut, remote, manifest, env })) {
      log.info("template repo detected; gate skipped");
      return 0;
    }
    ensureRemote({ git, gitOk, gitOut, remote, log, manifest, env });
    fetchUpstream({ git, remote, log });

    if (!state) {
      log.info("no sync state found; run update to seed state");
      return 0;
    }

    const base = baseline(syncCtx);
    const violations = drift(syncCtx, base.commit);
    if (violations.length) {
      log.error("gate failed", {
        ref: base.ref,
        commit: base.commit.slice(0, 8),
        violations,
        hint: "restore or remove drifted template-owned files, then re-run update",
      });
      return 1;
    }
    log.info("gate passed", {
      ref: base.ref,
      commit: base.commit.slice(0, 8),
    });
    return 0;
  };

  const cmdUpdate = (flags) => {
    if (isTemplateRepo({ gitOut, remote, manifest, env })) {
      log.info("template repo detected; nothing to sync");
      return 0;
    }

    validateFlag("ref", flags.ref ?? "x");
    if (flags.branch) validateFlag("branch", flags.branch);
    const branch = flags.branch || DEFAULT_SYNC_BRANCH;

    ensureRemote({ git, gitOk, gitOut, remote, log, manifest, env });
    fetchUpstream({ git, remote, log });

    const ref = resolveRef({ gitOut, remote }, flags.ref);
    const commit = resolveCommit({ gitOut, remote }, ref);
    if (!commit) {
      throw new Error(
        `upstream ref "${ref}" not found — check 'git tag' and 'git branch -r' after a fetch`,
      );
    }

    // Drift guard: only enforce against the last synced ref. A first sync has
    // no recorded state, so there is no prior baseline to violate.
    if (state) {
      const syncedAt = gitOut(["rev-parse", "--verify", `${state.commit}^{commit}`]);
      if (syncedAt) {
        const violations = drift(syncCtx, syncedAt);
        if (violations.length) {
          log.error("refusing to merge", {
            reason: "template-owned files drifted from the last sync",
            ref: state.ref,
            commit: state.commit.slice(0, 8),
            violations,
            hint: "restore them first, then re-run update",
          });
          return 1;
        }
      }
    }

    assertCleanWorktree({ gitOut, log });
    writeFileSync(pendingPath, `${ref}\n`);

    const headBefore = gitOut(["rev-parse", "HEAD"]);
    const checkout = git(["checkout", "-B", branch]);
    if (checkout.status !== 0) {
      clearPending(pendingPath);
      throw new Error(`git checkout -B ${branch} failed:\n${checkout.stderr}`);
    }

    const hasBase = gitOk(["merge-base", "HEAD", commit]);
    const merged = git([
      "merge",
      "--no-commit",
      "--no-edit",
      ...(hasBase ? [] : ["--allow-unrelated-histories"]),
      commit,
    ]);

    const merging = Boolean(gitOut(["rev-parse", "-q", "--verify", "MERGE_HEAD"]));
    if (merged.status !== 0 && !merging) {
      clearPending(pendingPath);
      throw new Error(
        `git merge of ${commit.slice(0, 8)} failed (merge never started):\n${merged.stderr}`,
      );
    }

    const conflicted = gitOut(["diff", "--name-only", "--diff-filter=U"]) ?? "";
    const overwriteConflicts = conflicted
      .split("\n")
      .filter(Boolean)
      .filter((p) => isOverwritePath(manifest, p));

    if (overwriteConflicts.length) {
      const r = git([
        "restore",
        "--source",
        commit,
        "--staged",
        "--worktree",
        "--",
        ...overwriteConflicts,
      ]);
      if (r.status !== 0) {
        if (merging) git(["merge", "--abort"]);
        clearPending(pendingPath);
        throw new Error(
          `resolving template-owned conflicts failed:\n${r.stderr}`,
        );
      }
    }

    const remaining = (gitOut(["diff", "--name-only", "--diff-filter=U"]) ?? "")
      .split("\n")
      .filter(Boolean);
    if (remaining.length) {
      log.error("merge conflicts remain", {
        paths: remaining,
        hint: "resolve them, git add each file, then run: bun run template-sync finish",
      });
      return 1;
    }

    if (gitOk(["diff", "--cached", "--quiet"])) {
      if (merging) git(["merge", "--abort"]);
      stageState(syncCtx, ref, commit);
      if (gitOk(["diff", "--cached", "--quiet"])) {
        clearPending(pendingPath);
        log.info("already up to date", { ref, commit: commit.slice(0, 8) });
        return 0;
      }
      commitState(git, `chore: record template sync state (${ref})`);
      clearPending(pendingPath);
      log.info("already up to date", { ref, commit: commit.slice(0, 8) });
      return 0;
    }

    stageState(syncCtx, ref, commit);
    const message = `chore: record template sync state (${ref})`;
    const c = merging
      ? git(["commit", "--no-verify", "--no-edit"])
      : git(["commit", "--no-verify", "-m", message]);
    if (c.status !== 0) {
      throw new Error(`git commit failed:\n${c.stderr}`);
    }
    clearPending(pendingPath);

    const stat = git(["diff", "--stat", headBefore, "HEAD"]);
    log.info("sync merged", {
      ref,
      commit: commit.slice(0, 8),
      branch,
      stat: stat.status === 0 ? stat.stdout.trim() : null,
    });
    return 0;
  };

  const cmdFinish = () => {
    const pendingRef = readPending(pendingPath);
    if (!pendingRef) {
      log.info("nothing pending");
      return 0;
    }

    const merging = gitOut(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    if (merging) {
      const conflicted = gitOut(["diff", "--name-only", "--diff-filter=U"]) ?? "";
      if (conflicted.trim()) {
        log.error("unresolved conflicts", { paths: conflicted.trim().split("\n").filter(Boolean) });
        return 1;
      }
      stageState(syncCtx, pendingRef, merging);
      const c = git(["commit", "--no-verify", "--no-edit"]);
      if (c.status !== 0) {
        throw new Error(`git commit failed:\n${c.stderr}`);
      }
    } else {
      const secondParent = gitOut(["rev-parse", "-q", "--verify", "HEAD^2"]);
      if (!secondParent) {
        log.error("no merge to finish");
        return 1;
      }
      stageState(syncCtx, pendingRef, secondParent);
      if (gitOk(["diff", "--cached", "--quiet"])) {
        clearPending(pendingPath);
        log.info("state already recorded");
        return 0;
      }
      commitState(git, `chore: record template sync state (${pendingRef})`);
    }

    clearPending(pendingPath);
    log.info("sync finished", { ref: pendingRef });
    return 0;
  };

  return {
    cmdInit,
    cmdCheck,
    cmdUpdate,
    cmdFinish,
  };
}
