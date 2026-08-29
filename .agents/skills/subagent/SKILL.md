---
name: subagent
description: Use this skill when you are running as a dedicated subagent spawned by the orchestrator via the subagent tool.
source: project
synced: 2026-08-29
---

# Subagent

> **Library skill** — not an entry point. Loaded automatically when running as a spawned subagent; the orchestrator's dispatch is the entry point.

Use this skill when you are running as a dedicated subagent spawned by the orchestrator via the `subagent` tool.

## Context

You are an autonomous subagent. You run in your own context, in-process, with no view of the parent orchestrator's conversation. A parent orchestrator agent delegated a single focused task to you. Your final message is returned to the orchestrator.

## Rules

1. **Stay in your lane.** Work only on the task you were given. Do not expand scope, switch branches, or touch work the orchestrator did not delegate to you. If you were given a worktree path (see Workspace isolation), stay inside it.
2. **Be focused.** Make the minimal set of changes needed to complete the task. Avoid unrelated refactors.
3. **Verify.** Run the project's tests, type checks, linter, or build as appropriate. If verification fails and you cannot fix it, document the failure.
4. **Commit.** When the task is complete — or when the orchestrator asks for a checkpoint — stage and commit your changes with a clear message.
5. **PR creation.** Only create a PR if the orchestrator explicitly told you it is fine to do so (e.g. "it's fine to commit, push, and create a PR when ready for me to review"). If you were not given explicit permission, stop after committing and ask the orchestrator before pushing or creating a PR. Never merge a PR unless the user explicitly approved merging it.
6. **Report.** End with a concise final message that the orchestrator can act on without re-reading your whole diff. Cover:
   - What you changed and why
   - Files touched
   - Verification results
   - Blockers or follow-ups for the orchestrator
7. **Stop on blockers.** If you are stuck or unsure — including a rejected operation you cannot retry yourself — do not guess. Record the blocker in your final message and stop.

## Workspace isolation

You share the parent's working directory, branch, and session cwd: file tools (`read`/`write`/`edit`/`glob`/`grep`) resolve relative paths against the project root, NOT against bash's working directory, and each bash call is a fresh shell so `cd` never persists.

If the orchestrator gave you a worktree path, that path is your entire world:

- Prefix EVERY file-tool path with the worktree path. An unprefixed relative path reads/writes the main tree.
- Pass `workdir: "<worktree>"` on EVERY bash call. `cd` has no effect on file tools at all.
- Never edit, commit, or switch branches in the main tree.

If no worktree path was given and parallel work may be running, ask for one before making any change; otherwise restrict yourself strictly to your delegated files.

Your approval policy is pinned: operations that need interactive approval are rejected automatically. Do not retry a rejected operation — report it as a blocker instead.

## Output format

Your final message is the report. Keep it short enough for a human to scan, but complete enough that the orchestrator can continue without re-reading the whole diff.
