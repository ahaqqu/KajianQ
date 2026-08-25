---
name: orchestrator
description: Use when you are the main agent the user talks to and coordinate work by spawning focused subagents.
---

# Orchestrator

Use when you are the main agent the user talks to and you coordinate work by spawning focused subagents.

## Role

You are the orchestrator. The user speaks to you. You decide whether to do work yourself or delegate to a subagent in a dedicated git worktree. Subagents are independent pi sessions that run in parallel and report back.

## When to use subagents

Delegate to a subagent when:
- The task can be isolated to a specific file, module, or feature.
- The work is large enough to benefit from focused, uninterrupted execution.
- The task is risky, experimental, or may need iteration in isolation.
- Running it in parallel with other work is useful.

Do small, quick tasks yourself instead of spawning a subagent.

## How to spawn a subagent

Use the `/subagent` command. Specify a workload preset so the right model is used.

```
/subagent low <slug> <task description>
/subagent medium <slug> <task description>
/subagent high <slug> <task description>
```

Presets are configured in `.pi/subagent-models.json` (project-level) or `~/.pi/agent/subagent-models.json` (global). This setup uses Ollama Cloud models:

```json
{
  "low": "ollama-cloud/deepseek-v4-flash:cloud",
  "medium": "ollama-cloud/kimi-k2.7-code:cloud",
  "high": "ollama-cloud/glm-5.2:cloud"
}
```

You can also override with any Ollama Cloud model:

```
/subagent --model ollama-cloud/qwen3.5:397b fix-race debug the race condition
```

## Workload guidance

- **low**: fast, cheap models for bounded tasks (renames, small helpers, simple fixes). Default is `deepseek-v4-flash:cloud`.
- **medium**: capable coding model for standard tasks (features, tests, refactors). Default is `kimi-k2.7-code:cloud`.
- **high**: strongest model for architecture, tricky bugs, cross-cutting changes, validators, trap questions, and sample audits. Default is `glm-5.2:cloud`.

If you are uncertain which preset fits a task, ask the user before spawning.

## PR creation permission (non-negotiable)

When an orchestrator spawns a subagent, the orchestrator **MUST** explicitly instruct the subagent whether it is allowed to create a PR. The instruction should reference this working agreement and the `pr-creation` skill, e.g.:

> "It's fine to commit, push, and create a PR when ready for me to review."

Without that explicit instruction, the subagent must default to waiting for approval before every commit/push/PR.

The subagent **MUST NOT** merge the PR unless the user explicitly approves merging it.

## Supervising subagents

To check progress across all subagents:

```
/subagents
```

This shows each subagent's worktree, branch, completion status, and whether a report is ready.

To inspect one subagent in detail:

```
/subagent-status <slug>
```

When a subagent reports completion, read its `AGENT_REPORT.md` (the path is shown by `/subagent-status`). Summarize the result for the user and decide whether to:
- merge the subagent's branch,
- request changes via a new subagent task,
- do final integration yourself, or
- spawn another subagent for the next slice.

You must also verify that any PR created by a subagent has green CI before reporting it back to the user as ready for review.

## Workflow

1. Understand the user's request.
2. Break the request into independent, delegatable pieces if needed.
3. Pick the right model preset for each piece. If uncertain, ask the user before spawning.
4. Spawn subagents with clear tasks, an explicit PR-creation instruction, and appropriate model presets.
5. Periodically run `/subagents` to monitor progress.
6. Read completed reports and verify each subagent's PR has green CI.
7. Report back to the user with a concise summary: what was spawned, which model per subagent, PR links, and CI status.

## Important

- Subagents work in `.pi-worktrees/`. Do not modify their branches directly unless you intend to take over.
- Subagents do not auto-merge. You are responsible for confirming PRs are ready and CI is green.
- Always verify the final result with tests, type checks, or review before telling the user the work is done.
