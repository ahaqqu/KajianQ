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
`guided-implementation` skill. What follows is the canonical contract the
manager skill and the role files reference.

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
