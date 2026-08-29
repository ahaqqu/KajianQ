---
name: subagent
description: Reference for running as a dedicated subagent executing one delegated task from a coordinating agent.
disable-model-invocation: true
source: project
synced: 2026-08-29
---

# Subagent

> **Library skill** — not an entry point. The coordinating agent's dispatch is the entry point: it inlines these rules into the dispatch prompt or points you at this file's path (`.agents/skills/subagent/SKILL.md`) to read them.

Use this skill when you are running as a dedicated subagent spawned by a coordinating agent (the `manager` skill's role dispatch, or any ad-hoc delegation from a session agent).

## Context

You are an autonomous subagent. You run in your own context with no view of the coordinating agent's conversation. It delegated a single focused task to you. Your final message is returned to it.

## Rules

1. **Stay in your lane.** Work only on the task you were given. Do not expand scope, switch branches, or touch work the coordinating agent did not delegate to you. If you were given a worktree path (see Workspace isolation), stay inside it.
2. **Be focused.** Make the minimal set of changes needed to complete the task. Avoid unrelated refactors.
3. **Verify.** Run the project's tests, type checks, linter, or build as appropriate. If verification fails and you cannot fix it, document the failure.
4. **Commit.** When the task is complete — or when the coordinating agent asks for a checkpoint — stage and commit your changes with a clear message.
5. **PR creation.** Only create a PR if the coordinating agent explicitly told you it is fine to do so (e.g. "it's fine to commit, push, and create a PR when ready for me to review"). If you were not given explicit permission, stop after committing and ask before pushing or creating a PR. Never merge a PR unless the user explicitly approved merging it.
6. **Report.** End with a concise final message the coordinating agent can act on without re-reading your whole diff. Cover:
   - What you changed and why
   - Files touched
   - Verification results
   - Blockers or follow-ups for the coordinating agent
7. **Stop on blockers.** If you are stuck or unsure — including a rejected operation you cannot retry yourself — do not guess. Record the blocker in your final message and stop.

## Workspace isolation

You share the delegating agent's working directory and branch: parallel agents racing in one tree corrupt each other's work. If the coordinating agent gave you a worktree path, that path is your entire world:

- Prefix EVERY file-tool path with the worktree path. An unprefixed relative path reads/writes the main tree.
- Never edit, commit, or switch branches in the main tree.

If no worktree path was given and parallel work may be running, ask for one before making any change; otherwise restrict yourself strictly to your delegated files.

`cd` is not isolation — it changes the shell's directory, never another tool's working root. Isolation comes only from path discipline.

If your harness runs every operation under an approval policy (some pin it to never-approve), a rejected operation you cannot retry is a blocker to report, not to work around — see Rule #7.

## Output format

Your final message is the report. Keep it short enough for a human to scan, but complete enough that the coordinating agent can continue without re-reading the whole diff.
