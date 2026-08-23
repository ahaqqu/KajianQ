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
  const changed = git(["diff", "--name-status", baseline, "--", ...paths]);
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
  return [...lines, ...extra].filter(Boolean);
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
