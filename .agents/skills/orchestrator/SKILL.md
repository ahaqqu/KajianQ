---
name: orchestrator
description: Use when you are the main agent the user talks to and coordinate work by spawning focused subagents.
---

# Orchestrator

Use when you are the main agent the user talks to and you coordinate work by spawning focused subagents.

## Role

You are the orchestrator. The user speaks to you. You decide whether to do work yourself or delegate to a subagent. Subagents are independent DeepSeek Harness (DSH) agents that run in their own context, in-process, and report back to you.

## When to use subagents

Delegate to a subagent when:
- The task can be isolated to a specific file, module, or feature.
- The work is large enough to benefit from focused, uninterrupted execution.
- The task is risky, experimental, or may need iteration in isolation.
- Running it in parallel with other work is useful.

Do small, quick tasks yourself instead of spawning a subagent.

## How to spawn a subagent

Use the `subagent` tool. It creates a fresh child agent with its own context — the child does **not** see your conversation, so give it a complete, standalone prompt. It runs in the background by default and returns a durable subagent id; set `run_in_background: false` only when your next action depends on its result.

```
subagent(prompt = "<complete, self-contained task>")
```

Start independent delegations together in one message and keep working while they run. When a background run settles, you are notified with its outcome and final message.

Use `subagent_fork` instead when the child needs your completed conversation context (a follow-up analysis, a review, a continuation). A fork sees your completed turns but not your in-flight turn.

## Model selection by difficulty

Pick a model per task by difficulty, exactly as the pi `/subagent` presets did. The available models (provider `ollama`, from `~/.dsh/settings.yaml`):

| Preset | Model | Use for |
|---|---|---|
| `low` | `ollama/deepseek-v4-flash:0731` | fast, cheap, bounded tasks (renames, small helpers, simple fixes) |
| `medium` | `ollama/kimi-k2.7-code` | capable coding model for standard tasks (features, tests, refactors) |
| `high` | `ollama/glm-5.2` | strongest reasoning for architecture, tricky bugs, cross-cutting changes, validators, trap questions, sample audits |

The `subagent` tool inherits your model — it has no per-call model override. To route a task to a specific model, use the `workflow` tool and pass the model per agent:

```
agent(prompt, { provider: "ollama", model: "glm-5.2" })
```

This works for a single delegation too (a workflow with one agent). If you are uncertain which preset fits a task, ask the user before spawning.

## Workspace isolation

Each subagent works in its own git worktree so parallel tasks never collide in the same working tree. Subagents inherit your working directory, so the worktree path in the prompt is what keeps each one isolated.

1. Create one worktree per subagent before spawning: `git worktree add -b agent/<slug> .worktrees/<slug>`.
2. In the subagent prompt, state the absolute worktree path and instruct it to `cd` there and stay inside it — never touch the main working tree.
3. On completion, the subagent commits in its worktree; you merge the `agent/<slug>` branch back and remove the worktree.

## PR creation permission (non-negotiable)

When an orchestrator spawns a subagent, the orchestrator **MUST** explicitly instruct the subagent whether it is allowed to create a PR. The instruction should reference this working agreement and the `pr-creation` skill, e.g.:

> "It's fine to commit, push, and create a PR when ready for me to review."

Without that explicit instruction, the subagent must default to waiting for approval before every commit/push/PR.

The subagent **MUST NOT** merge the PR unless the user explicitly approves merging it.

## Supervising subagents

- `list_agents` — list your continuable background subagents by id and label.
- `send_message` — continue a subagent's conversation (only your direct children).
- `interrupt_agent` — request cancellation of a subagent's current turn.

When a subagent settles, you are notified with its outcome and final message. Summarize the result for the user and decide whether to:
- merge the subagent's branch,
- request changes via a new subagent task,
- do final integration yourself, or
- spawn another subagent for the next slice.

You must also verify that any PR created by a subagent has green CI before reporting it back to the user as ready for review.

## Workflow

1. Understand the user's request.
2. Break the request into independent, delegatable pieces if needed.
3. Decide the model for each piece. If uncertain, ask the user before spawning.
4. Spawn subagents with clear, self-contained prompts and an explicit PR-creation instruction.
5. Keep working while they run; collect results as they settle.
6. Read completed reports and verify each subagent's PR has green CI.
7. Report back to the user with a concise summary: what was spawned, which model per subagent, PR links, and CI status.

## Important

- Subagents run in-process in their own context — there are no git worktrees. Do not modify a subagent's branch directly unless you intend to take over.
- Subagents do not auto-merge. You are responsible for confirming PRs are ready and CI is green.
- Always verify the final result with tests, type checks, or review before telling the user the work is done.
