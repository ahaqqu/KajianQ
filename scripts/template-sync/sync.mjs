import { resolveCommit, resolveRef } from "./git.mjs";
import { writeState } from "./state.mjs";

const STATE_FILE = ".template-sync.state";

export function validateFlag(name, value) {
  if (!value || typeof value !== "string" || value.startsWith("-")) {
    throw new Error(`Invalid --${name} value: ${value}`);
  }
}

export function drift({ git, manifest }, baseline) {
  const paths = manifest.overwrite;
  if (!paths.length) return [];
  // --no-renames (review A1 on PR #128): with rename detection on, a fork
  // that `git mv`s a template-shipped overwrite file away emits
  // `R100 old new`; taking the NEW path drops the drift entry and the gate
  // goes green while a template-owned file was deleted-and-replaced. Without
  // rename detection the same change reports `M old` + `D old` (old is in the
  // baseline → drift) and `A new` (not in the baseline → sanctioned fork
  // addition), which is exactly the intended adjudication. (quotePath is
  // disabled globally in createGit — review A2 — so non-ASCII paths in this
  // diff, the untracked listing, and the baseline tree all stay byte-exact.)
  const changed = git([
    "diff",
    "--no-renames",
    "--name-status",
    baseline,
    "--",
    ...paths,
  ]);
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    ...paths,
  ]);
  const lines =
    changed.status === 0 && changed.stdout
      ? changed.stdout.trim().split("\n")
      : [];
  const extra =
    untracked.status === 0 && untracked.stdout
      ? untracked.stdout.trim().split("\n").map((p) => `A\t${p}`)
      : [];
  // Overwrite-path drift is baseline-scoped (generalizing review A1 on PR
  // #127 from `.zcode/` to every overwrite path): only files the template
  // baseline actually ships can be drift — their modification or deletion.
  // Fork additions under overwrite directories (committed or untracked) are
  // sanctioned extensions, not drift: the template never shipped them, so a
  // fork that extends `.agents/skills/`, `.github/workflows/`, `scripts/`,
  // or `.zcode/` with its own files keeps the gate green and unblocks syncs.
  // Template-shipped files the fork deleted still count as drift (D entries
  // are in the baseline, and A1's --no-renames keeps rename-produced deletes
  // in the baseline too), and template modifications still drift forks —
  // that is the point of overwrite ownership. When the template itself
  // stops shipping a file (template-DELETE), the fork's copy is not in the
  // new baseline and is adjudicated exactly like a fork addition: not drift,
  // and no sync reconciles it. One `ls-tree -r` lists the baseline's
  // overwrite-path files into a Set (review A4 on PR #128) instead of one
  // `cat-file -e` spawn per drift entry.
  const tree = git([
    "ls-tree",
    "-r",
    "--name-only",
    baseline,
    "--",
    ...paths,
  ]);
  const baselineFiles = new Set(
    tree.status === 0 && tree.stdout
      ? tree.stdout.split("\n").filter(Boolean)
      : [],
  );
  return [...lines, ...extra]
    .filter(Boolean)
    .filter((entry) => baselineFiles.has(entry.split("\t").pop()));
}

export function baseline({ gitOut, remote, state, log }) {
  if (state) {
    const commit = gitOut(["rev-parse", "--verify", `${state.commit}^{commit}`]);
    if (commit) return { ref: state.ref, commit };
    log.warn("recorded sync commit not found; falling back to upstream default", {
      commit: state.commit,
    });
  }
  const ref = resolveRef({ gitOut, remote }, null);
  const commit = resolveCommit({ gitOut, remote }, ref);
  if (!commit) {
    throw new Error(
      `upstream ref "${ref}" not found — run 'bun run template-sync init' first`,
    );
  }
  return { ref, commit };
}

export function stageState({ git, statePath }, ref, commit) {
  writeState(statePath, { ref, commit });
  const add = git(["add", "--", STATE_FILE]);
  if (add.status !== 0) {
    throw new Error(`git add ${STATE_FILE} failed:\n${add.stderr}`);
  }
}

export function commitState(git, message, { allowEmpty = false } = {}) {
  const args = allowEmpty
    ? ["commit", "--no-verify", "--allow-empty", "-m", message]
    : ["commit", "--no-verify", "-m", message];
  const c = git(args);
  if (c.status !== 0) {
    throw new Error(`git commit failed:\n${c.stderr}`);
  }
}
