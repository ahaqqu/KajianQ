# Role agents (ZCode adapter layer)

These files are the ZCode adapter layer for the manager-orchestrated workflow
in `.agents/skills/manager/SKILL.md`. Each role the manager dispatches
(`implementer`, `reviewer`, `assistant-manager`) is a defined subagent whose
body carries its operating persona and completion criterion. The `reviewer`
is itself a coordinator: it applies the `code-review` skill (the single
review entry point — thermos depth mandatory for code-touching PRs) and
internally dispatches two sub-reviewers
(`thermo-nuclear-review-subagent` for security/correctness,
`thermo-nuclear-code-quality-review-subagent` for code quality), posting
findings via the `thermos-with-comments` skill.

These files are the **only** harness-specific part of the workflow. The skills
in `.agents/skills/` are intentionally harness-agnostic so forks can run the
same pipeline in other agent harnesses (including DeepSeek-family CLIs) by
supplying their own role-agent definitions.

## Model selection

Every role ships **pinned by default**: each agent file carries a
`model:` field, so the workflow runs on the same models everywhere unless
you override it. This project's committed pins name its ZCode custom-provider
channel (e.g. `custom:<workspace>:glm-5.3-flash%3Acloud` for the
implementer-class roles, `custom:<workspace>:kimi-k2.7-code%3Acloud` for the
review-side roles) — the caching-channel pinning from upstream template issue
#125 carried over as a channel change in template PR #130, which re-hosted the
role files under the new ZCode agent frontmatter format (quoted strings,
`color`, `injectAgentsMd`). Dispatching through a non-caching channel with
these role bodies is the single largest avoidable cost in the workflow.

Resolution order (used by ZCode):

1. **User override:** `~/.zcode/agents/<role>.md` (wins — the sanctioned
   per-user mechanism).
2. **Project pin:** `<repo>/.zcode/agents/<role>.md` (the pins below;
   `.zcode/` is a template-sync *merge* path — forks inherit template
   updates and may also customize these files locally; pins are
   client-managed and surface at dispatch time, not in CI).
3. **Template default:** the template's own role pins, used when a role
   file is absent from this directory.

**Mid-session pin caveat:** pin changes — committed or in user scope — only
reach *new* spawns after a client restart; the client caches its provider
registry and role definitions from startup, so a pin edited mid-session
keeps dispatching on the old channel until restart (observed live, issues
#110/#125).

The two sub-reviewer agents are children of `reviewer`. They are pinned
separately by default; a user-scope override that drops a sub-reviewer's
`model:` field makes it inherit the coordinator's model instead.

Recognized `model:` values (validated by ZCode at spawn time, not in CI —
since template PR #130 the machinery preflight gate `bun run
zcode:preflight` is retired; a pin that does not resolve fails the spawn
with "Model provider is not configured: <id>", which is fixed in the
client's provider config, never by rerouting the pin):

- `<channel>/<model>` — a concrete channel/model ref, e.g.
  `custom:d5585e04-940a-41f6-a9ec-320bb4fccd7e:glm-5.3-flash%3Acloud`.
  **The only accepted form** in committed role files.
- `inherit` — explicitly inherit the session default; not used in
  committed role files now that concrete pins ship.
- A bare `<modelName>` or an unconfigured ref — falls back to the session
  default or fails the spawn; never commit either.
- A concrete ref naming a **known-stale, non-caching channel** (currently
  `ollama/*`) — a regression in committed role files: the pins exist
  because the caching channel is the cheap one (issue #125).

### Thought level

Agent files may also pin a `thoughtLevel:` frontmatter field (valid values:
`low`, `medium`, `high`, `xhigh`, `max` — the harness validates against this
set). Pin it explicitly whenever a role's model offers reasoning variants,
because a provider's `defaultVariant` is not a safe default: GLM-5.3's
provider config ships `defaultVariant: "max"`, and an unpinned dispatch
resolved to `max` for an entire implementation run (see issue #94). All
dispatched roles pin `thoughtLevel: high`.

**Why `high` for the implementer-class roles specifically:** ticket routing
labels hard tickets `model:high`, which dispatches them to the
senior-implementer. Its intended reasoning mode is `high`, so the pin matches
the routing label — a dispatch can never fall through to the channel's
`defaultVariant` (`max` for GLM-5.3). The observed #6 run is the counterexample
the pin prevents: senior-implementer resolved to `max` for all 280 requests
(issues #94/#96).

The pin is declarative, not machine-checked: since template PR #130 the
machinery preflight gate is retired and pin health surfaces at dispatch time
(a non-resolving pin fails the child spawn with a visible
"Model provider is not configured: <id>" error, and the fix lives in the
client's provider config — never a committed reroute). The
"all dispatched roles pin `thoughtLevel: high`" claim above is enforced by
review discipline, not a CI gate. (After a real dispatch, recorded evidence
of the resolved variant is the telemetry DB's variant column, per issue #96.)

An invalid or unreachable `model:` falls back to the session default at
spawn time; it does not hard-fail. Check agent discoverability in ZCode via
**Settings → Subagents**.

### Pinned defaults per role

Pins are concrete per role, one channel per tier:

| Role | Agent file | Pinned model | Rationale |
| --- | --- | --- | --- |
| manager | (the session's own model — the manager is the session agent) | session model | orchestrates, never implements |
| implementer (default) | `implementer.md` | `custom:…:glm-5.3-flash` | caching channel; does most of the regular-complexity work |
| senior-implementer (hard/`model:high`) | `senior-implementer.md` | `custom:…:glm-5.3` | caching channel; tickets where failure is silent (validators, trap questions, sample audits) — do not downgrade `thoughtLevel` |
| reviewer (coordinator) | `reviewer.md` | `custom:…:kimi-k2.7-code` | coordinates the review and posts findings |
| thermo-nuclear-review-subagent | `thermo-nuclear-review-subagent.md` | `custom:…:glm-5.3` | security/correctness pass |
| thermo-nuclear-code-quality-review-subagent | `thermo-nuclear-code-quality-review-subagent.md` | `custom:…:kimi-k2.7-code` | maintainability pass |
| assistant-manager | `assistant-manager.md` | `custom:…:kimi-k2.7-code` | read-only fact-finding and adjudication evidence |
| test-implementer (`model:high` test phase) | `test-implementer.md` | `custom:…:glm-5.3-flash` | writes the suite from the senior's test brief; never touches production source, never opens a PR |

(The table abbreviates the full ref form `custom:<workspace>:<model>%3Acloud`
as `custom:…:<model>`; the authoritative string is the `model:` line in each
role file.)

## Phase-boundary discipline

The implementer-class roles (`implementer`, `senior-implementer`) carry an
operating discipline in their agent files, mirrored in the
`guided-implementation` skill (`.agents/skills/guided-implementation/SKILL.md`,
"Phase boundaries"): run **implement → handoff → test loop → report**
as explicit phases. Follow all three boundaries:

1. Checkpoint commit at every test-green point.
2. Hand the verification loop to a fresh scoped context (compaction, where the
   harness provides it, is equivalent) *before* entering test iteration.
3. Address review findings in a fresh context *after* review, never in the
   implementation context.

Ownership note: the skill path is template-owned per the narrow overwrite
entries in `template-sync.json` (including `.agents/skills/manager/`), so
forks inherit the discipline; `.zcode/` is a template-sync *merge* path —
forks inherit template updates and may customize role files locally (this
project carries its own pin channel, per template PR #130's re-hosting).
Per-user re-pinning goes through `~/.zcode/agents/<role>.md`.

## Iteration guardrail and stuck reports

Implementer-class roles run under the mechanical iteration guardrail (issue
#98): a workspace hook (`scripts/iteration-guardrail/`, wired in
`.zcode/config.json`) counts failed verification cycles per session and
**denies** verification reruns past progress-based caps — 3 failed cycles on
the same failure, 8 failed cycles since the last successful verification
(both configurable in `scripts/iteration-guardrail/config.json`). The hook
is scoped (issue #123) to subagent dispatches only — `scope:
"subagents-only"` in the config, matching the observed `sess_subagent_agent_*`
session-id convention — so interactive sessions are a full no-op. It fails
open on its own internal errors and never blocks non-verification
commands, so a checkpoint commit is always available. The manager's
decision table for acting on a stuck report lives in the manager skill
(`.agents/skills/manager/SKILL.md`, Reliability & supervision).

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

Each phase above runs under a hard budget: **~150k billed input tokens or
~150 requests, whichever is hit first**. These are the registry defaults for
the implementer-class roles; a role profile (`.zcode/agents/<role>.md`) or
an individual dispatch may override them tighter. When a phase passes its
budget, the subagent does not keep expanding context — it makes a checkpoint
commit, pushes the branch, and hands off: to a fresh scoped context carrying
the last checkpoint, or back to the manager through its normal report
channel. A budget handoff is compliance, not failure; silently continuing
past the budget is the anti-pattern. The manager restates this clause in
every implementer-class dispatch prompt (`.agents/skills/manager/SKILL.md`,
§1 Dispatch).

### Watchdog backstop thresholds (defaults)

The manager's efficiency watchdog (`.agents/skills/manager/SKILL.md`,
Reliability & supervision → Efficiency watchdog) independently watches every
dispatched role subagent from telemetry and acts on a breach. These registry
defaults are the canonical values; a role profile (`.zcode/agents/<role>.md`)
or an individual dispatch may override them tighter, never looser:

| Per-dispatch budget | Default |
| --- | --- |
| Billed input tokens (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`) | ~5M |
| Requests (`model_usage` rows) | ~600 |
| Wall time | ~120 min |
| Stall | `STALL_MINUTES` (manager skill, default 30) |

A dispatch spans three billed phases (implement → test loop → report; the
handoff between them is a context boundary, not a billed phase), so every
dimension with a per-phase counterpart must sit strictly above the
worst-case compliant dispatch — per-phase cap × 3. Per dimension: billed
input ~5M is ~11× the worst case (~450k); requests ~600 sit strictly above
the worst case (3 × ~150 = ~450) — the rule is that the request backstop
must exceed the per-phase request cap × the expected billed phase count,
never equal or undercut it; wall time has no per-phase counterpart, so no
such arithmetic applies and ~120 min is a free-plan-safe ceiling for a
typical dispatch, not a margin over a per-phase budget. A subagent honoring
the escape hatch hands off long before a breach, so a breach is evidence
the subagent is ignoring the hatch (or that a respawn is re-burning). Detection is from telemetry evidence — the ZCode
telemetry DB `~/.zcode/cli/db/db.sqlite` (`model_usage` / `tool_usage`),
the AgenQ dashboard (`http://localhost:8787/api/state`), or the agent
record's `metadata.json` usage block (`docs/AGENT-USAGE-METADATA.md`;
capture-time-only — post-hoc, never a live mid-run signal) —
never from subagent prose. On a breach the manager dispatches the
assistant-manager (role C, read-only) to analyze why, then nudges the
subagent via the continue mechanism, respawns it from its last checkpoint,
or escalates to the owner. Watchdog failure (DB or dashboard unavailable) is
observable and never blocks the main loop.

## Role registry

This directory is the role-file home the ZCode harness parses (see the
pinned-defaults table above). The *dispatch* mechanics for running the
manager loop live in the per-harness adapters under
`.agents/skills/manager/`: `.agents/skills/manager/ZCODE-ADAPTER.md`
(reference harness) and `.agents/skills/manager/DSH-ADAPTER.md`
(DeepSeek Harness — verified).

## Adapting to another harness

The workflow in `.agents/skills/manager/SKILL.md` relies on exactly these
capabilities, which any harness must supply to run it end-to-end:

1. A subagent/Task tool with named `subagent_type` + background dispatch.
2. Agent-definition files per role (this directory) with a per-role model
   field.
3. `gh` CLI access (subagents use `gh` for PR and comment operations).

To run on another harness, create the **same-named role agents** in that
harness's agent-definition directory, translating the frontmatter model key
to that harness's convention — or, when the harness parses no agent files,
give it an adapter that honors these pins through its own dispatch rule.

This repo's second harness **DSH (DeepSeek Harness)** works exactly that way:
its verified adapter — dispatch recipe for all six roles and the pin-routing
rule — lives in `.agents/skills/manager/DSH-ADAPTER.md` (ADR-0005).

