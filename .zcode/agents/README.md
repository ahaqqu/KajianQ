# Role registry (`.zcode/agents/`)

This directory holds the role-agent definitions the manager-orchestrated
workflow dispatches. Each role is a defined subagent whose file carries its
operating persona, frontmatter, and completion criterion. The `reviewer`
coordinates the review: it applies the `code-review` skill and dispatches the
two thermo-nuclear sub-reviewers, posting findings via `thermos-with-comments`.

| Role | File | Purpose |
| --- | --- | --- |
| implementer (default) | `implementer.md` | regular guided implementation, end-to-end to a green PR |
| senior-implementer | `senior-implementer.md` | hard / `model:high` tickets — correctness invariants that fail silently |
| test-implementer | `test-implementer.md` | on `model:high` tickets, writes the suite from the senior's test brief; never touches production source, never opens a PR |
| reviewer (coordinator) | `reviewer.md` | applies `code-review` end-to-end and posts itemized findings |
| thermo-nuclear-review-subagent | `thermo-nuclear-review-subagent.md` | security/correctness pass |
| thermo-nuclear-code-quality-review-subagent | `thermo-nuclear-code-quality-review-subagent.md` | maintainability pass |
| assistant-manager | `assistant-manager.md` | read-only fact-finding and adjudication evidence |

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

Role subagents may be given dedicated GitHub identities (ADR-0025), enforced
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

The implementer-class roles run under the mechanical iteration guardrail
(hook `scripts/iteration-guardrail/`, wired in `.zcode/config.json`, caps in
`scripts/iteration-guardrail/config.json`) and the phase-boundary discipline
from the `guided-implementation` skill. What follows is the canonical
contract the manager skill and the role files reference.

### Stuck-report format (canonical)

When the guardrail denies a verification rerun — or whenever an agent judges
the loop stuck before the mechanical cap fires — it stops looping and reports
a **stuck-report** to the manager, containing exactly:

1. **Invariant under test** — the property the work must protect, stated so the receiver can verify it.
2. **Exact current failure** — the verification command and the precise error output.
3. **Attempted fixes** — every fix attempt, each with its outcome.
4. **Ruled-out hypotheses** — what was already eliminated and how.
5. **Checkpoint commit ref** — the work is committed to the branch **first**; escalation must never lose work.

The receiver must be able to act on this without re-deriving the history.
**Never fake done:** the completion criterion is unchanged by the guardrail —
a PR must exist and all its checks must be green. A cap, a deny, or a
stuck-report never substitutes for that evidence; escalate instead.

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

### Watchdog backstop thresholds (defaults)

The manager's efficiency watchdog independently watches every dispatched
role subagent from telemetry and acts on a breach. These registry defaults
are canonical; a role profile or an individual dispatch may override them
tighter, never looser:

| Per-dispatch budget | Default |
| --- | --- |
| Billed input tokens (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`) | ~5M |
| Requests (`model_usage` rows) | ~600 |
| Wall time | ~120 min |
| Stall | `STALL_MINUTES` (manager skill, default 30) |

The backstop must sit strictly above the worst-case compliant dispatch —
per-phase budget × the expected billed phase count — on every dimension that
has a per-phase counterpart, so a run honoring the escape hatch never trips
it. A breach is therefore evidence the subagent is ignoring the hatch (or
that a respawn is re-burning). Detection is from telemetry evidence — the
ZCode telemetry DB (`model_usage` / `tool_usage`) or the agent record's
`metadata.json` usage block (`docs/AGENT-USAGE-METADATA.md`; post-hoc,
never a live mid-run signal) — never from subagent prose. On a breach the
manager dispatches the assistant-manager to analyze why, then nudges,
respawns from the last checkpoint, or escalates to the owner. Watchdog
failure (telemetry unavailable) is observable and never blocks the main loop.