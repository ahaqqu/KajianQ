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

## Adapting to another harness

The workflow in `.agents/skills/manager/SKILL.md` relies on exactly these
capabilities, which any harness must supply to run it end-to-end:

1. A subagent/Task tool with named `subagent_type` + background dispatch.
2. Agent-definition files per role (this directory) with a per-role model
   field.
3. `gh` CLI access (subagents use `gh` for PR and comment operations).

To run on another harness, create the **same-named role agents** in that
harness's agent-definition directory, translating the frontmatter model key
to that harness's convention.

## DeepSeek Harness (DSH) adapter — verified

This repo's primary harness (see README "Agentic development") **is** DSH,
and the adapter below is verified against the installed DSH checkout
(2026-08-29) with live smoke tests: foreground and background spawn,
`send_message` continuation, a nested two-level spawn, and `workflow`
per-agent model overrides. DSH has no named agent types and no
agent-definition files, so a role's *body travels in the prompt*: copy the
body of the role's file in this directory (everything under the frontmatter)
into the spawn prompt, keep the task on top, and name the skill the role
must apply.

### Dispatch recipe — all six roles

| Role file | DSH dispatch (verified) |
| --- | --- |
| `implementer.md` | generic `subagent`, background (`run_in_background` default). Returns a durable subagent id; continue with `send_message`. |
| `senior-implementer.md` | same spawn mechanics; model pinning via `workflow` (see model routing). |
| `reviewer.md` | generic `subagent`, background. Verified: it can spawn its two sub-reviewers itself (nested depth 2). |
| `thermo-nuclear-review-subagent.md` | child generic `subagent` spawned by the reviewer, with the review baseline (`## Prompt` section) of `thermo-nuclear-review/SKILL.md` inlined. DSH has no `subagent_type` for it; this is the fallback `thermos-with-comments` already allows. |
| `thermo-nuclear-code-quality-review-subagent.md` | child generic `subagent` with the baseline prompt of `thermo-nuclear-code-quality-review/SKILL.md` inlined. |
| `assistant-manager.md` | generic `subagent`, background. DSH exposes no per-call tool filter, so its read-only constraint is enforced by the role body alone. |

Mechanics: continue a child with `send_message`, list with `list_agents`,
cancel a stalled turn with `interrupt_agent`; a child's result arrives as a
settle notice. DSH subagents run with approval policy pinned to `never` — a
rejected operation is a blocker to report, never a retry. DSH subagents
inherit the session cwd and branch: for parallel implementers use gitignored
worktrees and require absolute-path prefixing on file tools plus `workdir:`
on every bash call (see the manager skill's DSH adapter).

### Model routing on DSH

The `subagent` tool has no per-call model override — children inherit the
session model. To route a role to its pinned model, use the `workflow` tool
(`agent(prompt, { provider: "ollama", model: "…" })`), where a pin of
`ollama/<model>:cloud` maps to `<model>`. Trade-offs, verified on this
install (2026-08-29):

- `workflow` runs in the foreground and its children are one-shot — a
  model-pinned implementer cannot be resumed with `send_message`; when its
  CI goes red, spawn a fresh workflow agent carrying the failing logs.
- Routing status by pin: `glm-5.3-flash` (session default), `kimi-k2.7-code`,
  `kimi-k3`, and `glm-5.2` route; **`glm-5.3` and `deepseek-v4-flash:0731`
  fail** (the workflow child resolves `null`). Until those ids route on DSH,
  dispatch a `model:high` ticket there through `glm-5.2` — the strongest
  verified high-reasoning target. ZCode is unaffected: its pins resolve
  inside ZCode.

### End-to-end support status

- **ZCode:** runs the manager loop end-to-end (reference adapter — named
  role agents, per-role model resolution, `SendMessage` continuation).
- **DSH:** runs the manager loop end-to-end — spawn, nested review, and
  `send_message` continuation are verified — with the two trade-offs above:
  role bodies are inlined rather than name-resolved, and exact model pinning
  is only available through (one-shot) `workflow` dispatches.

