# Role registry (`.zcode/agents/`)

This directory holds the role-agent definitions the manager-orchestrated
workflow dispatches. Each role is a defined subagent whose file carries its
operating persona, frontmatter, and completion criterion. The `reviewer`
applies the `code-review` skill end-to-end, runs both thermo passes itself, and posts findings via `thermos-with-comments`.

| Role                  | File                    | Purpose                                                                                              |
| --------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| implementer (default) | `implementer.md`        | regular guided implementation, end-to-end to a green PR                                              |
| senior-implementer    | `senior-implementer.md` | hard / `model:high` tickets — correctness/trust invariants that fail silently; also writes the tests |
| fixer                 | `fixer.md`              | owns review feedback: accepts/rejects each thermos item, applies accepted fixes, keeps CI green      |
| reviewer              | `reviewer.md`           | applies `code-review` end-to-end and runs both thermos passes itself; posts itemized findings        |

The manager is the session agent itself — it has no role file.

Dispatch mechanics live in `.agents/skills/manager/SKILL.md` and its
per-harness adapters; this directory only defines the roles.

## Model pins

Each role file's frontmatter carries its `model:` and `thoughtLevel:` pin.
**The role files are the single source of truth for pin values** — they are
not repeated here, so they cannot drift. Override precedence in ZCode:

1. `~/.zcode/agents/<role>.md` — user-scope override, wins.
2. `<repo>/.zcode/agents/<role>.md` — the committed project pins.
3. Session default — used when no pin resolves.

A pin that fails to resolve fails the spawn with
"Model provider is not configured: `<id>`". The fix lives in the client's
provider config — never reroute a committed pin to a different model. Pin
changes reach new spawns only after a client restart. Removing a role
file's `model:` field makes that role inherit its dispatcher's model (this
is how a sub-reviewer can be made to share its coordinator's model).

## Role GitHub identities

Role subagents may be given dedicated GitHub identities, enforced
mechanically: the PreToolUse hook `scripts/role-gh-identity/hook.mjs` denies
a bare `gh` call from a role with a configured identity and names the
compliant form, `gh-as <role> <gh args…>`
(`scripts/role-gh-identity/gh-as.mjs` — per-invocation `GH_TOKEN`, token
files outside the repo). Enforcement is opt-in
(`scripts/role-gh-identity/config.json`, `enabled: false` by default); the
hook fails open on every internal error, and the manager session (no role)
is never denied. A `gh-as` auth failure surfaces as an ordinary command
failure — the manager relays and escalates it like any CI failure, never
bypasses the wrapper.

## Implementer-class operating rules

The implementer-class roles follow the phase-boundary discipline from the
`guided-implementation` skill. Each role file is **self-contained**: it
carries the full operating contract inline — phase boundaries, budget
handoff, stuck-report format, workspace isolation, dispatch authorization —
so a dispatched agent never needs a second file read. This section documents
the same contract for the manager and human readers; the role files remain
the operative copy. If you change the contract, change every role file in
the same commit.

### Stuck-report format (canonical)

When an implementer-class agent judges the loop stuck, it stops looping and
reports a **stuck-report** to the manager, containing exactly:

1. **Invariant under test** — the property the work must protect, stated so the receiver can verify it.
2. **Exact current failure** — the verification command and the precise error output.
3. **Attempted fixes** — every fix attempt, each with its outcome.
4. **Ruled-out hypotheses** — what was already eliminated and how.
5. **Checkpoint commit ref** — the work is committed to the branch **first**; escalation must never lose work.

The receiver must be able to act on this without re-deriving the history.
**Never fake done:** the completion criterion is unchanged — a PR must exist
and all its checks must be green. A stuck-report never substitutes for that
evidence; escalate instead.

### Workspace isolation (canonical)

Implementer-class roles share a checkout with the dispatching session and
possibly other parallel dispatches — racing in one tree switches each other's
branches mid-run and corrupts each other's diffs. Therefore:

- At dispatch start, create your own temporary worktree and do **all** work
  (edits, commits, gates, pushes) inside it:
  `git worktree add /tmp/wt-<branch> -b <branch> origin/main`.
  The fixer is the exception: it attaches the existing worktree
  (`/tmp/wt-<branch>`) or adds one from the existing branch
  (`git worktree add /tmp/wt-<branch> <branch>` — no `-b`), because it takes
  over a branch that already exists.
- Before **any** `git` state-changing operation (commit, push, branch,
  checkout), verify with `git branch --show-current` that you are on your
  dispatch's branch inside your worktree. Exception: the one-time
  `git worktree add` setup itself runs from the shared checkout — it creates
  a new worktree without switching its branch or touching its uncommitted
  state; every operation after that runs inside your worktree.
- Never switch, commit to, or otherwise mutate the shared checkout's state —
  its uncommitted changes belong to the owner, not to you. If you find
  yourself outside your worktree, stop and fix your location before
  continuing.

### Dispatch authorization (canonical)

Implementer-class roles are explicitly authorized to commit, push, and open a
pull request for the assigned task. Never merge it — the manager verifies CI
and asks the owner before merging.

### Context budgets (defaults)

Each implementer-class phase runs under a hard budget: **~150k billed input
tokens or ~150 requests, whichever is hit first**. These are the registry
defaults; a role profile (`.zcode/agents/<role>.md`) or an individual
dispatch may override them tighter. When a phase passes its budget, the
subagent does not keep expanding context — it makes a checkpoint commit,
pushes the branch, and hands off: to a fresh scoped context carrying the
last checkpoint, or back to the manager through its normal report channel.
A budget handoff is compliance, not failure; silently continuing past the
budget is the anti-pattern.
