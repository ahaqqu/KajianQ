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

