# ADR-0047: Worktree liveness is declared with `git worktree lock`, and the sweep is gated fail-closed

## Status

Accepted (2026-09-27). Closes the residual the cleanup rule carried since #229:
`scripts/worktree-cleanup.mjs` could remove a worktree whose PR was merged at
its branch tip while a dispatch was actively working in it, because branch state
cannot distinguish "deferred cleanup" from "a dispatch that has just reattached
to a surviving squash-merged branch".

It does not change who cleans up — ADR-0031 leaves that with the manager — it
changes how the cleanup decides what is disposable. It amends nothing else: no
product surface, no runtime path, no contract, no spend. It rejects the
documentation-only gate, the lock alone, and every inferred-liveness heuristic
(worktree admin-dir age, file mtimes, `HEAD` reflog), all recorded below.

## Context

- **The tool, and the rules it already had.** `bun run worktree:clean` is the
  manager's cleanup for the dispatch worktrees under `.worktrees/<slug>` (#229).
  It removes an entry whose GitHub PR is `MERGED` **at the branch tip** and whose
  branch carries commits beyond `origin/main` (rule 1); a branch with no unique
  commits and a worktree with no `agent/<slug>` branch are kept with their reason
  and swept only behind `--include-unstarted` / `--include-detached` (rules 2 and
  3); dirty entries are kept without `--force`; unmerged work is always kept.
- **The hazard is bit-identical to the normal case.** A dispatch reattached
  without `-b` to a surviving squash-merged branch — same slug, branch still at
  the merged PR's head, clean because it has only read files — is
  indistinguishable from a finished branch whose cleanup was deferred. Rule 1's
  tip check cannot separate them, and no commit is lost when it fires (the
  deleted ref is the merged PR's own head, already contained in `main`), which
  is exactly why the failure is quiet: the live dispatch loses its worktree and
  branch mid-run and nothing reports it.
- **The only trigger is a cleanup during an active dispatch.** The manager skill
  allows that "only when no dispatch is active" — prose the operator must
  remember. PR #238's re-review reproduced the shape (P3), which is the evidence
  that memory is the wrong enforcement point.
- **Inference cannot see liveness here.** The registration of a reattached
  worktree is old (it survived the merge), and a dispatch that has only read
  files leaves no trace to time: no commits, no mtime worth trusting, no reflog
  entry. A declaration is required precisely because the observables are silent.

## Decision

**Two layers, each covering the other's hole: git's own lock as the declaration,
and a mechanical operator gate on the sweep.**

1. **Rule 0 — a lock is a liveness declaration.** A dispatch locks its worktree
   when it creates it, with a reason naming its role and ticket
   (`git worktree lock .worktrees/<slug> --reason "<role> #<issue>"`), and
   unlocks it before reporting done. The sweep parses the blocks of
   `git worktree list --porcelain` (not just the `worktree ` lines), and keeps
   any entry carrying `locked`, printing the reason. This check runs **before
   every other rule and every flag**: a lock dominates `--force`, dirty state,
   PR state, `--include-unstarted` and `--include-detached`. `git worktree
remove` refuses a locked tree, so the keep states the tool boundary rather
   than a guess about branch state.
2. **The gate — `--no-active-dispatches` is required to destroy.** Without it,
   every removal a sweep would make is withheld: the run prints the same verdict
   lines a sweep would act on (`would remove <slug> (<reason>)`), names the flag
   and why it is required on stderr (`refusing to remove N worktree(s): pass
--no-active-dispatches once you have confirmed no dispatch is active`), exits
   non-zero, and prints no `done:` line. A gated run with nothing to remove
   withholds nothing and so refuses nothing: it prints `nothing to remove:
--no-active-dispatches is only needed when there is something to remove`,
   then the ordinary `done: 0 removed, N kept`, and exits 0. `--dry-run` needs
   no acknowledgement and still exits 0. Forgetting the flag destroys nothing.
3. **The remedy — `--unlock <slug>`, repeatable, never automatic.** It runs
   `git worktree unlock .worktrees/<slug>`, prints the outcome, and exits
   non-zero when the slug is not a locked worktree. It never sweeps (the closing
   line says so), so clearing a declaration and destroying the worktree stay two
   separate, named acts; a `--dry-run --unlock` reports without clearing.
4. **The sweep's other behaviour is unchanged.** The `registered` set stays
   realpath-based, rule ordering and reasons stay as they were, and the header's
   `RESIDUAL (#239)` paragraph and usage line are replaced by the resolved
   design.
5. **The convention is stated where the worktree is created.** The manager
   skill's dispatch requirement carries the lock-at-creation/unlock-before-done
   line, its cleanup bullet carries the required flag and the lock semantics,
   and the role files and both harness adapters carry the same one-line duty.

## Rationale

- **A declaration is the only discriminator.** The lock is the mechanism git
  already provides for exactly this ("keep this worktree, whatever else is
  going on"), and it is enforced below the tool: even a bug in the sweep cannot
  remove a declared-live worktree.
- **The gate covers the declaration's window.** A dispatch that has not locked
  yet — or forgot to — is protected by nothing but the operator's
  acknowledgement. The gate makes that acknowledgement mechanical instead of a
  remembered convention, and its failure mode is a refused cleanup, never a
  destroyed worktree.
- **The normal path pays nothing.** A dispatch that finishes unlocks before
  reporting done, so the sweep behaves exactly as before; the gate is one token
  on a command the manager already runs deliberately.
- **Clearing a declaration stays auditable.** A crashed dispatch's lock could
  block its own worktree forever, so a remedy is required — but naming one slug
  at a time, never sweeping, and never running automatically keeps the remedy an
  operator act, which is the opposite of the inferred-liveness heuristics this
  decision rejects.
- **No new primitive, no new spawn.** `lock`, `unlock` and `list --porcelain`
  are ordinary `git` calls, so the spawn surface stays `git` and `gh` and the
  destruction suite's pin stays meaningful.

## Alternatives considered

- **The operator gate alone, as documentation.** Safety stays a property of how
  the tool is called, and the P3 reproduction is the evidence that memory is the
  wrong enforcement point. Rejected as the whole answer; kept as layer 2, made
  mechanical.
- **The lock alone.** A dispatch that forgets to lock is unprotected, and the
  window before its first lock is wide open. Rejected: the flag covers exactly
  that window without depending on the convention having been followed.
- **Inferred liveness — worktree admin-dir age, file mtimes, `HEAD` reflog.**
  No reliable discriminator. In the surviving-worktree reattach case the
  registration is old and the branch state is the merged PR's own; a dispatch
  that has only read files leaves no trace at all. Rejected: a heuristic that
  guesses here fails silently in the destructive direction.
- **`--unlock` that unlocks and then sweeps in the same invocation.** Rejected:
  it makes clearing a declaration the first half of a removal, so a manager who
  wanted only to clear a lock (to resume a crashed dispatch, say) would destroy
  the worktree instead. The closing line of an `--unlock` run states the split.
- **Requiring `--no-active-dispatches` for `--unlock` too.** Rejected: unlocking
  destroys nothing, and the gate exists to guard destruction.
- **Rejecting unknown flags outright.** Not adopted: the change is about the
  destruction boundary, and a new argument-validation policy would be a
  behaviour change beyond what the residual needs.

## Consequences

- **A dispatch that dies after locking leaves its worktree blocked from the
  sweep** until an operator unlocks it deliberately. That is the intended trade:
  the block is visible (the entry is kept with its reason, and the keep line
  names the remedy), and the alternative is a heuristic that can be wrong in the
  destructive direction.
- **The lock is a one-shot declaration whose reason cannot be edited in place.**
  `git worktree lock` accepts only `--reason` and has no `--force`, so a second
  `lock` on an already-locked worktree fails with
  `fatal: '<path>' is already locked, reason: <reason>` and the original reason
  stands. A round that re-runs its lock line — a respawn, a resume, or a fixer
  taking over A's tree — refreshes the reason with `git worktree unlock <path>`
  then `git worktree lock <path> --reason "<role> #<ticket>"`, and never clears
  that error by leaving a worktree it is working in unlocked: an unlocked, clean
  tree whose branch looks merged (PR merged at the branch tip with unique
  commits) is removed by the default sweep, and an unstarted or detached one
  only with the sweep's explicit flags — the lock is the one keep no flag
  reaches, which is the state it exists to prevent.
- **The window between a worktree's creation and its lock is covered by the gate
  only.** Accepted: closing it needs the dispatch's own declaration, which is
  what layer 1 is.
- **A removal that races a lock is still a keep.** If a lock appears after the
  run has parsed the listing, `git worktree remove` fails and the entry is kept
  with the failure named, and the branch is not deleted — the worktree is still
  the only ref holder at that point.
- **`--dry-run` remains non-mutating in all modes**, including `--unlock`, so a
  preview of the remedy cannot clear a live declaration.
- **The script grew, the spawn surface did not.** Every new call goes through the
  existing `git` helper, so the destruction suite's spawn pin keeps its meaning.
- **The convention is now a duty in five role files and the manager skill**, so
  the mechanism depends on dispatches locking. The gate is the backstop when one
  does not.

## Evidence

- `tests/scripts/worktree-cleanup.test.mjs` — the locked-entry case (now kept by
  rule 0, with its PR history never consulted) and the #239 cases: a locked
  entry kept against `--force --include-unstarted --include-detached` with no PR
  lookup at all; the same entry swept once unlocked; a lock appearing mid-run
  (through the fake `gh`'s side effect) kept with the branch intact; a withheld
  sweep printing the same verdicts and removing nothing with a non-zero exit,
  with `--dry-run` still exiting 0; a gated run with nothing to remove printing
  the no-op wording and exiting 0, on the same fixture as the refusal;
  `--unlock` clearing only the named entry,
  repeatably, never sweeping; `--unlock` failing visibly for an unknown and an
  unlocked slug and for a missing value; `--dry-run --unlock` reporting without
  clearing.
- `tests/scripts/worktree-cleanup-destruction.test.mjs` and
  `tests/scripts/worktree-cleanup-isolation.test.mjs` stay green **unmodified**:
  the fixture appends the gate acknowledgement for deliberate sweeps, so no
  existing case's subject changed.
- Manual fixture runs for the fail-closed behaviour (no flag → `would remove`
  verdicts, `refusing to remove 1 worktree: pass --no-active-dispatches once you
have confirmed no dispatch is active`, exit 1) and for lock dominance over
  `--force` (locked entry kept, unlocked sibling removed).

## Implementation map

- `scripts/worktree-cleanup.mjs` — block-structured porcelain parse, rule 0, the
  gate, `--unlock`, header and usage.
- `tests/scripts/worktree-cleanup-fixture.mjs` — gate acknowledgement by default
  (`{ withholdGate: true }` to omit it), real `lock`/`unlock` helpers,
  `lockState` read from git's own listing, a fake-`gh` side effect for the
  mid-run lock.
- `tests/scripts/worktree-cleanup.test.mjs` — the cases above.
- `.agents/skills/manager/SKILL.md` (dispatch requirement, cleanup bullet,
  workspace isolation, fixer worktree), `DSH-ADAPTER.md`, `ZCODE-ADAPTER.md`.
- `.zcode/agents/README.md` (canonical workspace isolation),
  `implementer.md`, `senior-implementer.md`, `fixer.md`, `reviewer.md`.
- `SPECS.md` §8 — this ADR's row.

## Revisit triggers

- `git worktree list --porcelain` or `git worktree unlock` changing semantics —
  the parse is block-structured and the remedy leans on git's own error.
- Cleanup becoming automated (a hook or timer): the gate assumes a human
  operator passing the acknowledgement.
- A second driver of the sweep, which would need the same gate.
- A lock blocking a legitimate sweep in the normal path more than once — that
  would mean the unlock-before-reporting-done convention is not surviving
  dispatches, and the duty needs a hook rather than prose.
