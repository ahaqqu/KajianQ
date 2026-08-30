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
`model: <providerId>/<modelName>` field, so the workflow runs on the same
models everywhere unless you override it.

Resolution order (used by ZCode):

1. **User override:** `~/.zcode/agents/<role>.md` (wins — best place for
   personal model choices that shouldn't be committed to the repo).
2. **Project pin:** `<repo>/.zcode/agents/<role>.md` (edit the files in
   this directory to change a per-project choice).
3. **Template default:** the pinned `model:` in these files (table below).

The two sub-reviewer agents are children of `reviewer`. They are pinned
separately by default; delete a sub-reviewer's `model:` field to make it
inherit the coordinator's model instead.

Recognized `model:` values:

- `inherit` — explicitly inherit the session default (equivalent to omitting
  the field).
- `lite` — the harness's configured lite model (cheaper tier).
- `<providerId>/<modelName>` — a concrete provider/model ref, e.g.
  `ollama/glm-5.3:cloud`.
- A bare `<modelName>` resolved against the session's default provider.

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

The pin is machine-checked: `bun run zcode:preflight` fails when any role file
in this directory omits `thoughtLevel:`, pins a value outside the validated
set, or — for the six dispatched roles above — pins anything other than
`high`, so the "all dispatched roles pin `thoughtLevel: high`" claim above is
blocking, not prose. Forks inherit this gate (it lives in template-owned
`scripts/`) but own this directory: a fork-added role file must carry a
`thoughtLevel:` pin (any validated value; the dispatched role names must pin
`high`) or the preflight fails. (The gate checks the config the client loads,
not the running client — after a real dispatch, recorded evidence of the
resolved variant is the telemetry DB's variant column, per issue #96.)

An invalid or unreachable `model:` falls back to the session default; it does
not hard-fail. Check agent discoverability in ZCode via
**Settings → Subagents**.

### Pinned defaults per role

| Role | Agent file | Pinned model | Rationale |
| --- | --- | --- | --- |
| manager | (the session's own model — the manager is the session agent) | session model | orchestrates, never implements |
| implementer (default) | `implementer.md` | `ollama/glm-5.3-flash:cloud` | fast tier — does most of the regular-complexity work |
| senior-implementer (hard/`model:high`) | `senior-implementer.md` | `ollama/glm-5.3:cloud` | stronger tier — tickets where failure is silent (validators, trap questions, sample audits); do not downgrade |
| reviewer (coordinator) | `reviewer.md` | `ollama/kimi-k2.7-code:cloud` | coordinates the review and posts findings |
| thermo-nuclear-review-subagent | `thermo-nuclear-review-subagent.md` | `ollama/glm-5.3:cloud` | security/correctness pass |
| thermo-nuclear-code-quality-review-subagent | `thermo-nuclear-code-quality-review-subagent.md` | `ollama/kimi-k2.7-code:cloud` | maintainability pass |
| assistant-manager | `assistant-manager.md` | `ollama/kimi-k2.7-code:cloud` | read-only fact-finding and adjudication evidence |
| test-implementer (`model:high` test phase) | `test-implementer.md` | `ollama/glm-5.3-flash:cloud` | writes the suite from the senior's test brief; never touches production source, never opens a PR |

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

Ownership note: the skill path is template-owned (`.agents/` is an
`overwrite` entry in `template-sync.json`), so forks inherit the discipline;
`.zcode/agents/` is unlisted in that map (project-owned), so this directory
is where a fork customizes or extends it.

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

