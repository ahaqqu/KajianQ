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
import { isManifestPath, isOverwritePath } from "./manifest.mjs";
import { clearPending, readPending, writeState } from "./state.mjs";
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

  // Record sync state against an upstream ref WITHOUT merging. This is the
  // safe path for forks bootstrapped via tree-copy (unrelated histories),
  // where `update` would trigger --allow-unrelated-histories and conflict
  // across every merge-path file. `seed` asserts that the current
  // template-owned files match the target ref, then writes .template-sync.state
  // so `check`/`gate` begins enforcing drift.
  const cmdSeed = (flags) => {
    if (isTemplateRepo({ gitOut, remote, manifest, env })) {
      log.info("template repo detected; nothing to seed");
      return 0;
    }

    validateFlag("ref", flags.ref ?? "x");

    ensureRemote({ git, gitOk, gitOut, remote, log, manifest, env });
    fetchUpstream({ git, remote, log });

    const ref = resolveRef({ gitOut, remote }, flags.ref);
    const commit = resolveCommit({ gitOut, remote }, ref);
    if (!commit) {
      throw new Error(
        `upstream ref "${ref}" not found — check 'git tag' and 'git branch -r' after a fetch`,
      );
    }

    // Refuse to seed a lie: the current template-owned files must match the
    // target ref. If they drifted, the user must `update` (to pull the ref's
    // files) or restore them manually before seeding.
    const violations = drift(syncCtx, commit);
    if (violations.length) {
      log.error("refusing to seed", {
        reason: "template-owned files do not match the target ref",
        ref,
        commit: commit.slice(0, 8),
        violations,
        hint: "run 'bun run template-sync update --ref=" + ref + "' to pull the ref, or restore the files, then seed",
      });
      return 1;
    }

    // --no-commit: write the state file without staging/committing.
    // Used in CI to auto-seed before the gate check without creating a
    // commit in the ephemeral runner.
    if (flags.noCommit) {
      writeState(statePath, { ref, commit });
      log.info("state seeded (no-commit)", {
        ref,
        commit: commit.slice(0, 8),
        next: "bun run template-gate now enforces drift against this ref",
      });
      return 0;
    }

    assertCleanWorktree({ gitOut, log });
    stageState(syncCtx, ref, commit);
    if (gitOk(["diff", "--cached", "--quiet"])) {
      log.info("state already recorded", { ref, commit: commit.slice(0, 8) });
      return 0;
    }
    commitState(git, `chore: record template sync state (${ref})`);
    log.info("state seeded", {
      ref,
      commit: commit.slice(0, 8),
      next: "bun run template-gate now enforces drift against this ref",
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
      log.info("no sync state found; run seed or update to record state");
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

    // When no --ref is given, prefer the recorded state's ref over the
    // latest v* tag. The state ref is the line we last synced along; a tag
    // is only useful for a first sync (no state yet). Without this, a stale
    // tag older than the state commit sends the merge backwards (the tag is
    // an ancestor of what the fork already has), re-introducing every file
    // the fork holds and producing add/add conflicts across all merge paths.
    const ref = resolveRef({ gitOut, remote }, flags.ref ?? state?.ref);
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

    // A tree-copy fork (bootstrapped without shared git history) turns every
    // file that exists on both sides into an add/add conflict, even merge-path
    // files the fork customized (apps/, packages/, README.md, …). Overwrite
    // paths were resolved above; the remaining conflicts are merge-path files
    // the fork owns. When there is no merge-base (unrelated histories), keep
    // the fork's content (--ours) for those files — the fork's customizations
    // must survive the first sync. A shared-history merge still surfaces these
    // as real conflicts for the human to resolve.
    const afterOverwrite =
      (gitOut(["diff", "--name-only", "--diff-filter=U"]) ?? "")
        .split("\n")
        .filter(Boolean);
    if (afterOverwrite.length && !hasBase) {
      const r = git(["checkout", "--ours", "--", ...afterOverwrite]);
      if (r.status !== 0) {
        if (merging) git(["merge", "--abort"]);
        clearPending(pendingPath);
        throw new Error(
          `resolving merge-path conflicts (--ours) failed:\n${r.stderr}`,
        );
      }
      const add = git(["add", "--", ...afterOverwrite]);
      if (add.status !== 0) {
        if (merging) git(["merge", "--abort"]);
        clearPending(pendingPath);
        throw new Error(`git add of --ours resolutions failed:\n${add.stderr}`);
      }
    }

    // Non-manifest paths are project-owned: the template must never leave
    // them conflicted for a human. Auto-resolve to the fork's version —
    // including shared-history merges, where both sides edited the same
    // project file (e.g. a fork-tuned README vs the template's). Only
    // merge-path conflicts remain for manual resolution.
    const conflictedProjectPaths =
      (gitOut(["diff", "--name-only", "--diff-filter=U"]) ?? "")
        .split("\n")
        .filter(Boolean)
        .filter((p) => !isManifestPath(manifest, p));
    if (conflictedProjectPaths.length) {
      const oursKept = conflictedProjectPaths.filter((p) =>
        gitOk(["cat-file", "-e", `:2:${p}`]),
      );
      const oursDeleted = conflictedProjectPaths.filter(
        (p) => !gitOk(["cat-file", "-e", `:2:${p}`]),
      );
      if (oursKept.length) {
        const r = git(["checkout", "--ours", "--", ...oursKept]);
        if (r.status !== 0) {
          if (merging) git(["merge", "--abort"]);
          clearPending(pendingPath);
          throw new Error(
            `resolving non-manifest conflicts (--ours) failed:\n${r.stderr}`,
          );
        }
        const add = git(["add", "--", ...oursKept]);
        if (add.status !== 0) {
          if (merging) git(["merge", "--abort"]);
          clearPending(pendingPath);
          throw new Error(
            `git add of non-manifest conflict resolutions failed:\n${add.stderr}`,
          );
        }
      }
      if (oursDeleted.length) {
        const rm = git(["rm", "--quiet", "--", ...oursDeleted]);
        if (rm.status !== 0) {
          if (merging) git(["merge", "--abort"]);
          clearPending(pendingPath);
          throw new Error(
            `removing non-manifest paths deleted by the fork failed:\n${rm.stderr}`,
          );
        }
      }
      log.info("resolved non-manifest conflicts with the fork's version", {
        kept: oursKept,
        deleted: oursDeleted,
      });
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

    // Restore the project branch's version for any path not covered by the
    // manifest. Paths outside overwrite/merge are project-owned: the template
    // must not add, update, or delete them. This prevents upstream-only product
    // code from leaking into forks that do not list those paths.
    const mergedPaths = gitOut(["ls-files"]) ?? "";
    const nonManifestPaths = mergedPaths
      .split("\n")
      .filter(Boolean)
      .filter((p) => !isManifestPath(manifest, p));
    if (nonManifestPaths.length) {
      const existsOnMain = gitOut([
        "ls-tree",
        "-r",
        "--name-only",
        headBefore,
        "--",
        ...nonManifestPaths,
      ]) ?? "";
      const existingSet = new Set(existsOnMain.split("\n").filter(Boolean));
      const toRestore = nonManifestPaths.filter((p) => existingSet.has(p));
      const toRemove = nonManifestPaths.filter((p) => !existingSet.has(p));

      if (toRestore.length) {
        const restore = git(["checkout", "--ours", "--", ...toRestore]);
        if (restore.status !== 0) {
          if (merging) git(["merge", "--abort"]);
          clearPending(pendingPath);
          throw new Error(
            `restoring project version of non-manifest paths failed:\n${restore.stderr}`,
          );
        }
        const add = git(["add", "--", ...toRestore]);
        if (add.status !== 0) {
          if (merging) git(["merge", "--abort"]);
          clearPending(pendingPath);
          throw new Error(`git add of restored paths failed:\n${add.stderr}`);
        }
      }

      if (toRemove.length) {
        const rm = git(["rm", "-r", "--cached", "--", ...toRemove]);
        if (rm.status !== 0) {
          if (merging) git(["merge", "--abort"]);
          clearPending(pendingPath);
          throw new Error(`removing upstream-only paths failed:\n${rm.stderr}`);
        }
      }

      log.info("reconciled non-manifest paths", {
        count: nonManifestPaths.length,
        restored: toRestore.length,
        removed: toRemove.length,
        sample: nonManifestPaths.slice(0, 5),
      });
    }

    // Stage the state file BEFORE checking for net changes. In an unrelated-
    // histories sync every shared file resolves to --ours, so the only staged
    // difference is the state file. If we checked for changes first we would
    // abort the merge and lose the upstream parent (the merge-base for the next
    // sync). The state commit always changes when upstream advances, so this
    // keeps MERGE_HEAD alive and produces a real two-parent merge commit.
    stageState(syncCtx, ref, commit);

    if (gitOk(["diff", "--cached", "--quiet"])) {
      // Truly nothing changed (upstream commit matches last synced commit).
      if (merging) git(["merge", "--abort"]);
      clearPending(pendingPath);
      log.info("already up to date", { ref, commit: commit.slice(0, 8) });
      return 0;
    }

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
    cmdSeed,
    cmdUpdate,
    cmdFinish,
  };
}
