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

Your dispatch prompt carries your role body (`.zcode/agents/<role>.md`, or its inlined equivalent) — it defines your persona and completion criterion. Role dispatches span the workflow's whole range: an implementer producing a PR, a reviewer or audit subagent producing findings, an assistant-manager producing verified facts. The shared rules below apply to every one of them; where a rule turns on whether your role changes the tree or only reads it, your role body decides.

## Rules

1. **Stay in your lane.** Work only on the task you were given. Do not expand scope, switch branches, or touch work the coordinating agent did not delegate to you. If you were given a worktree path (see Workspace isolation), stay inside it.
2. **Be focused.** Do only what the task requires: the minimal set of changes when the task produces changes, and no changes at all when the task is analysis, review, or fact-finding. Avoid unrelated refactors.
3. **Verify.** Prove your outcome the way your role's completion criterion requires — run the project's tests, type checks, linter, or build when the task produces code; ground every finding or fact in the diff with `file:line` references and verbatim evidence when the task is review or fact-finding; confirm the externally observable artifact when the task ends in one (a PR whose checks are green, a posted comment visible on the PR). If verification fails and you cannot fix it, document the failure.
4. **Commit and open a PR when your role produces one.** When the task produces file changes, stage and commit them with a clear message — at completion, or when the coordinating agent asks for a checkpoint — and, when your role body carries the Dispatch authorization, push and open the PR when the work is ready for review; the dispatch's authorization covers it, so no further permission is asked. Read-only roles — review, audit, fact-finding — change no git state and open nothing: their report is the deliverable. Never merge a PR unless the user explicitly approved merging it.
5. **Report.** End with a concise final message the coordinating agent can act on without re-reading your full output. Cover:
   - What you did or found, and why
   - The deliverable your role owes: what changed and the files touched, itemized findings with priority and location, or verified facts with evidence references
   - Verification results
   - Blockers or follow-ups for the coordinating agent
6. **Stop on blockers.** If you are stuck or unsure — including a rejected operation you cannot retry yourself — do not guess. Record the blocker in your final message and stop.

Your task may itself include coordinating further subagents (a reviewer dispatching its two sub-reviewers is the pattern). The same rules govern that coordination: keep your own dispatches in their lanes, verify their observable artifacts before building on them, and fold their results into your single final report.

## Workspace isolation

You share the delegating agent's working directory and branch: parallel agents racing in one tree corrupt each other's work. If the coordinating agent gave you a worktree path, that path is your entire world:

- Prefix EVERY file-tool path with the worktree path. An unprefixed relative path reads/writes the main tree.
- Never edit, commit, or switch branches in the main tree.

If no worktree path was given and parallel work may be running, ask for one before making any change; otherwise restrict yourself strictly to your delegated files.

`cd` is not isolation — it changes the shell's directory, never another tool's working root. Isolation comes only from path discipline.

If your harness runs every operation under an approval policy (some pin it to never-approve), a rejected operation you cannot retry is a blocker to report, not to work around — see Rule #6.

## Output format

Your final message is the report. Keep it short enough for a human to scan, but complete enough that the coordinating agent can continue without re-reading your full output.
