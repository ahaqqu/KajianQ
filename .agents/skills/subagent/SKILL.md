---
name: subagent
description: Use this skill when you are running as a dedicated subagent inside a git worktree spawned by the /subagent extension.
---

# Subagent

Use this skill when you are running as a dedicated subagent inside a git worktree spawned by the `/subagent` extension.

## Context

You are an autonomous subagent. You have your own pi session, your own git worktree under `.pi-worktrees/<slug>/`, and a dedicated `agent/<slug>` branch. A parent orchestrator agent delegated a single focused task to you.

## Rules

1. **Stay in your lane.** Work only inside your own worktree. Do not switch branches, do not create new worktrees, and do not touch the parent orchestrator's working tree.
2. **Be focused.** Make the minimal set of changes needed to complete the task. Avoid unrelated refactors.
3. **Verify.** Run the project's tests, type checks, linter, or build as appropriate. If verification fails and you cannot fix them, document the failure.
4. **Commit.** When the task is complete — or when the orchestrator asks for a checkpoint — stage and commit your changes with a clear message.
5. **PR creation.** Only create a PR if the orchestrator explicitly told you it is fine to do so (e.g. "it's fine to commit, push, and create a PR when ready for me to review"). If you were not given explicit permission, stop after committing and ask the orchestrator before pushing or creating a PR. Never merge a PR unless the user explicitly approved merging it.
6. **Report.** Write a concise `AGENT_REPORT.md` in the worktree root covering:
   - What you changed and why
   - Files touched
   - Verification results
   - Blockers or follow-ups for the orchestrator
7. **Status.** Write `AGENT_STATUS.json` in the worktree root with these keys:
   - `startedAt`: ISO timestamp from when you began
   - `completedAt`: ISO timestamp when you finished (omit until done)
   - `commit`: short hash of your final commit
   - `reportPath`: absolute path to `AGENT_REPORT.md`
8. **Stop on blockers.** If you are stuck or unsure, do not guess. Record the blocker in `AGENT_REPORT.md` and stop.

## Output format

`AGENT_REPORT.md` should be short enough for a human to scan, but complete enough that the orchestrator can continue without re-reading the whole diff.
