# Role registry (`.zcode/agents/`)

This directory holds the role-agent definitions the manager-orchestrated
workflow dispatches. Each role is a defined subagent whose file carries its
operating persona, frontmatter, and completion criterion. The `reviewer`
applies the `code-review` skill end-to-end, runs both thermo passes itself when the diff touches code, and posts findings via `thermos-with-comments` at thermos depth.

| Role                  | File                    | Purpose                                                                                              |
| --------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| implementer (default) | `implementer.md`        | regular guided implementation, end-to-end to a green PR                                              |
| senior-implementer    | `senior-implementer.md` | hard / `model:high` tickets — correctness/trust invariants that fail silently; also writes the tests |
| fixer                 | `fixer.md`              | owns review feedback: accepts/rejects each itemized finding, applies accepted fixes, keeps CI green  |
| reviewer              | `reviewer.md`           | applies `code-review` end-to-end, running both thermos passes itself when the diff touches code      |
| qa                    | `qa.md`                 | adversarial staging verification of a merged change — verdict with per-probe evidence; no worktree   |

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

On every harness — DSH included — a role subagent's `gh` runs
under the dispatching session's ambient identity: no role is denied a bare
`gh`, and the manager session (no role) is never denied. The DSH adapter states
this as it applies on DSH.

## Implementer-class operating rules

The implementer-class roles follow the phase-boundary discipline from the
`guided-implementation` skill. Each role file is **self-contained**: it
carries the full operating contract inline — phase boundaries, budget
handoff, stuck-report format, workspace isolation, dispatch authorization —
so a dispatched agent never needs a second file read. This section documents
the same contract for the manager and human readers; the role files remain
the operative copy. If you change the contract, change every role file in
the same commit.

### Todo discipline (canonical)

Every implementer-class role maintains its plan in its own `todo_write` task
list — a dispatch-contract duty, not a personal preference:

- **Whole-list replacement.** Each `todo_write` call sends the complete list;
  there is no partial update.
- **One `in_progress`.** Exactly one item is `in_progress` at a time, unless
  parallel work (several subagents genuinely in flight) justifies more.
- **Update at every phase boundary.** Write or revise the list before a long
  gate run, at a handoff (implement → test loop → report), and whenever scope
  changes. Never let it go stale behind the work.
- **Per-session and turn-scoped.** The list is never inherited from the
  manager, and DSH clears it at each `turn/start`; each subagent creates and
  owns its own list and keeps it current within its own turn. An empty list
  while work is in flight means the owner cannot see the plan or the progress.

The completion criterion is unchanged: a green PR is the evidence, and the todo
list is progress telemetry, never a substitute for it.

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

- At dispatch start, create your own worktree under the repo's committed
  `.worktrees/` directory and do **all** work (edits, commits, gates, pushes)
  inside it: from the shared checkout run
  `git worktree add .worktrees/<slug> -b agent/<slug> origin/main`.
  The fixer is the exception: it attaches the existing worktree
  (`.worktrees/<slug>`) or adds one from the existing branch
  (`git worktree add .worktrees/<slug> agent/<slug>` — no `-b`), because it
  takes over a branch that already exists.
- Lock the worktree as soon as it exists, with a reason naming your role and
  ticket (`git worktree lock .worktrees/<slug> --reason "<role> #<issue>"`), and
  unlock it (`git worktree unlock .worktrees/<slug>`) before reporting done: a
  locked worktree is kept by `bun run worktree:clean` whatever flags it is
  passed, so the lock is the liveness declaration that protects an active
  dispatch's work through a cleanup. `lock` is not idempotent: a worktree that
  is already locked is one an earlier round declared live, so leave the lock in
  place, or refresh its reason with `git worktree unlock .worktrees/<slug>` then
  `git worktree lock .worktrees/<slug> --reason "<role> #<issue>"` — never leave
  a worktree you are working in unlocked: an unlocked, clean tree whose branch
  looks merged is removed by the default sweep.
- Never put a worktree under `/tmp` (on DSH it is per-invocation — see the DSH
  adapter). Never use `.wt/` either — `.worktrees/` is the one in-repo
  convention, it is committed to `.gitignore`, and `bun run worktree:clean`
  (run from the main checkout) owns removal, keeping any branch with unmerged
  work. Cleanup is the manager's duty, not yours.
- Before **any** `git` state-changing operation (commit, push, branch,
  checkout), verify with `git branch --show-current` that you are on your
  dispatch's branch (`agent/<slug>`) inside your worktree. Exception: the
  one-time
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
