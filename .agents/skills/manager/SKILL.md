---
name: manager
description: Orchestrate the implement → review → fix loop as a supervising manager. Spawns an implementer subagent (guided-implementation) to produce a PR, verifies CI once at the implementer's completion report, spawns a reviewer subagent (code-review, posting findings via thermos-with-comments), relays findings to the implementer, supervises accept/reject/fix until CI is green, then summarizes and recommends next steps. User-invoked — type "manager <task>".
disable-model-invocation: true
source: project
synced: 2026-08-29
---

# Manager

You are the manager. Your job is to **orchestrate**, not implement. You spawn, monitor, and supervise role subagents; you never write or review code yourself.

## Roles

| Role                   | Role agent (`.zcode/agents/`) | Skill                                               | What it does                                                                                                                                                                                                                                        |
| ---------------------- | ----------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — implementer        | `implementer`                 | `guided-implementation`                             | Implements regular/complexity-normal tasks end-to-end, opens a PR, keeps CI green.                                                                                                                                                                  |
| A — senior-implementer | `senior-implementer`          | `guided-implementation`                             | Implements hard / `model:high` tickets; works the correctness/trust invariant first and designs for verification; writes tests as part of the same run.                                                                                             |
| B — reviewer           | `reviewer`                    | `code-review` (posting via `thermos-with-comments`) | Reviews the PR: applies the `code-review` skill — philosophy/guardrail compliance plus both thermo passes, which the reviewer runs itself — then posts itemized review comments (`A1…`, `B1…`, `C1…`) plus a summary comment with a recommendation. |
| C — fixer              | `fixer`                       | `guided-implementation` + `code-review`             | Owns review feedback: reads the PR and findings in a fresh context, accepts or rejects each item, applies accepted fixes, keeps CI green.                                                                                                           |

The manager role runs in the session itself. Every role agent is defined and model-pinned in a role file under `.zcode/agents/` — that pin is the single source of truth for role models on every harness, and each harness adapter defines how it honors it. The skills are harness-agnostic.

## Harness adapters

The loop runs on any harness that can spawn a background subagent, continue it later, and drive `gh`. Load the adapter file for your harness — you know which you are from your own spawn tools — and let it resolve every step marked "per your harness adapter":

- **ZCode** → `.agents/skills/manager/ZCODE-ADAPTER.md`

## Non-negotiables

- **Never report a step done without observable evidence**: a PR URL that exists, comments present on the PR, `gh pr checks` output green. Subagent prose alone is not evidence.
- **Never paper over failure.** If a subagent stalls or CI stays red after retries, escalate to the user with the concrete blocker. A flaky or silently-skipped step is unacceptable.
- **Relay CI failures verbatim.** When CI goes red on A's PR, send A the raw failing-check logs. A fixes; you do not debug.

## Workflow

### 0. Intake

- Establish the task scope: what the change is, what done looks like, and the target branch (default `main`).
- If the task is underspecified, grill the user (`grill-with-docs`) or escalate before spawning A. A clear task up front prevents flaky downstream runs.

### 1. Dispatch A (implement)

Choose the implementer type using the **dispatch decision** below, then spawn it in the background (per your harness adapter). The prompt must state: the task, the Definition of Done in `AGENTS.md`, that **A owns CI green** — it watches its own checks and iterates on red until green, reporting completion only when the criterion **PR URL + `gh pr checks` green** holds (canonical statement: the CI protocol in Reliability & supervision; duplicated here because the dispatch prompt is what A actually reads) — and that it must apply `guided-implementation`. For a `senior-implementer` dispatch, also require it to lead with the invariant and design-for-verification statement.

**Completion criterion (verified):** the implementer returns a PR URL; `gh pr view <url>` confirms the PR exists and is open.

#### Dispatch decision: implementer vs senior-implementer

Pick the implementer type by **label first, then judgment**, exactly once per ticket at dispatch time (this decides which role agent is dispatched — the spawn mechanism, named type or inlined body, comes from your harness adapter; it does not change either agent's definition):

- If the ticket is labeled **`model:high`** → spawn `senior-implementer`. These tickets carry a correctness/trust invariant that fails silently; do not downgrade them.
- If the ticket has no model label → use your own judgment: spawn `senior-implementer` when you assess the work as hard (cross-cutting change, correctness/trust risk, or a silent-failure mode not yet codified as a label), otherwise spawn `implementer`. Record why in the final summary.
- If the ticket is labeled **`model:plus-human`** → do not dispatch implementation at all. A human curation/verification gate holds an acceptance criterion; the ticket cannot be closed by code. Escalate to the user instead.

### 2. Verify A's completion

A owns CI green: it watches its own checks, iterates on red, and reports done only when the PR exists and all checks pass. You do not monitor CI between dispatches.

- When A reports done, verify once, one-shot: `gh pr view <pr>` confirms the PR exists and is open; `gh pr checks <pr>` confirms every check green. No `--watch`, no scheduled automation, no polling.
- Red at A's completion report → send A the failing check name and `gh run view --log-failed` output verbatim via your adapter's continue mechanism. Resume the same A (its agent/subagent id) — do not spawn a new implementer unless A has crashed; a model-pinned dispatch that cannot be resumed respawns fresh carrying the logs, after the respawn intake check. Repeat until A reports green or stalls.

### 3. Dispatch B (review)

Spawn the reviewer role (per your harness adapter) in the background. It applies the `code-review` skill (the single review entry point — for a code-touching PR the thermos depth is mandatory) and posts the itemized findings via `thermos-with-comments`, running both thermo passes itself. Its prompt must hand it the PR number/URL and require its completion criterion: **every item posted as a review comment + summary comment present**.

**Completion criterion (verified):** `gh pr view <pr> --comments` shows the summary comment (contains "Thermos review") and at least as many review comments as items in B's returned report.

### 4. Dispatch C (fixer)

The fixer reuses A's worktree (`/tmp/wt-<branch>`) if it still exists, or adds a fresh one from the existing branch (`git worktree add /tmp/wt-<branch> <branch>` — no `-b`). State the worktree path in C's dispatch prompt.

Send C: B's full itemized report (verbatim) including each item's posted review-comment ID, and these instructions:

1. For each item, post its disposition as a **threaded reply on that item's original review comment** — never a separate PR/issue comment or a reply on the summary thread: `gh api repos/{owner}/{repo}/pulls/<pr>/comments/<comment_id>/replies -f body=…` (the route requires the PR number in the path — the ID-only form `pulls/comments/{id}/replies` 404s). The reply body is **accept** or **reject** plus one-sentence reasoning.
2. **Verify every reply landed** before reporting: `gh api repos/{owner}/{repo}/pulls/<pr>/comments` shows each finding's comment with a reply whose `in_reply_to_id` matches that finding's comment ID. A disposition that is not a threaded reply on the original comment does not count.
3. For every accepted item, apply the fix; re-run `bun run check && bun run test && bun run size-limit` locally.
4. Keep CI green; push fixes to the same branch.
5. Post a **resolution report** as a PR comment listing each item ID, its disposition, the threaded reply (comment ID), and the commit that fixed it (for accepted items).
6. Report back: PR URL, item dispositions, final `gh pr checks` status.

### 5. Verify C's fix loop

- Wait for C's resolution report comment (verify with `gh pr view --comments`).
- Verify `gh pr checks <pr>` is green after C's fixes.

### 6. Summarize and recommend

Produce the final user-facing summary:

- **What happened**: scope, what A implemented, the PR URL, CI history (red→green transitions if any).
- **Dispatch rationale**: which implementer type you spawned for this ticket (implementer vs senior-implementer) and why (label or judgment).
- **Review outcome**: B's recommendation, item counts by priority, and the final accept/reject disposition per item.
- **Cleanup**: after the PR merges or closes, remove A's temporary worktree (`git worktree remove /tmp/wt-<branch>`) and C's if it created a separate one — you own this; A and C cannot observe the merge (see Workspace isolation).
- **Workflow observations**: what went smoothly, what stalled, what required retries.
- **Next-step recommendation**: e.g. merge (B's compliance + thermos passes already ran), follow-up tickets, or escalating a rejected-High to the user.
- **Workflow improvement suggestion**: at least one concrete change to this skill, the role agent files, or the relay protocol that would have made this run faster or more reliable. This is a standing duty of the manager — if everything went perfectly, say so and skip.

## Reliability & supervision

- **Subagent results.** Capture each spawn's agent/subagent id. Continue a running child with your adapter's continue mechanism. Read a child's result from its report/settle notice — not from a transcript-style output tool (your adapter documents the specifics).
- **Objective verification over prose.** Every awaited artifact is verified independently (`gh pr view`, `gh pr checks`, `gh api`), not trusted from a subagent's message.
- **Workspace isolation.** Every implementer-class dispatch (and any dispatch that will run `git` state-changing operations — commit, branch, push, checkout) must work in its own temporary `git worktree`, never in the session's shared checkout: `git worktree add /tmp/wt-<branch> -b <branch> origin/main`. Parallel dispatches in one tree switch each other's branches mid-run and corrupt each other's diffs — this has been observed live, not hypothesized. State the worktree path in the dispatch prompt and require the subagent to verify `git branch --show-current` before every state-changing `git` operation. Cleanup duty is yours: when the PR merges or closes, remove the worktree (`git worktree remove /tmp/wt-<branch>`) — the implementer cannot observe the merge, so it cannot own this. A fresh worktree deliberately does **not** carry the shared checkout's uncommitted state — that exclusion is the isolation boundary, not a defect.
- **Fixer worktree.** C reuses A's worktree (`/tmp/wt-<branch>`) if it still exists, or adds a fresh one from the existing branch (`git worktree add /tmp/wt-<branch> <branch>` — no `-b`). The manager states the worktree path in C's dispatch prompt.
- **Stall rule.** Configurable: `STALL_MINUTES` (default 30). If a background subagent produces no observable artifact within that window, send one "status?" ping via the continue mechanism. On continued stall, respawn the subagent fresh (new id) after the respawn intake check below, re-issuing the original prompt when no checkpoint exists. After two stalled attempts, escalate to the user.
- **Respawn intake.** Before respawning fresh for a task whose earlier attempt died (stall respawn, orphan, provider failure, session kill), first recover prior progress so the respawn resumes instead of re-burning exploration from zero. Check, in order — no PR number is needed for any check, because the task branch is known from the dispatch: (1) **pushed commits** on the task branch — `git fetch` then `git log origin/<branch>`; (2) **leftover temporary worktree with uncommitted progress** — `git worktree list` for a `/tmp/wt-<branch>` path, then `git -C <worktree> status --short` (a leftover worktree is recoverable state, not garbage; a dirty one means the dead attempt was mid-edit); (3) **open draft PR** — `gh pr list --head <branch> --state open --json number,title,isDraft`. Only after (3) locates a PR, read it with `gh pr view <pr>` for its head commit and details. Whatever you find is the **last checkpoint**: the respawn prompt must state it explicitly (branch, head commit, worktree path with dirty files, PR URL) and instruct the subagent to continue from it — reattach the existing worktree or add a fresh one with `git worktree add /tmp/wt-<branch> <branch>` (no `-b`: the branch already exists from the dead attempt; `-b` is only for creating the branch fresh at first dispatch), inspect the checkpoint before re-exploring, reuse existing commits, and push to the same branch/PR. Only when all three checks come up empty does the respawn get the original from-scratch prompt.
- **CI protocol.** **A owns CI green; C owns keeping it green after review fixes; the manager verifies once.** The implementer-class role (A) watches its own PR's checks and iterates on red until green — with checkpoint commits — and reports completion only when all checks pass; the fixer (C) does the same for review fixes. This bullet is the canonical statement of the split, duplicated in A's dispatch prompt (step 1) and the fix-loop relay (step 4). The manager never monitors, watches, or schedules anything for CI: no `gh pr checks --watch`, no per-PR scheduled automation, no polling. The manager's only CI action is one-shot verification at A's completion report (step 2) and at C's completion report (step 5) — `gh pr view <pr>` open + `gh pr checks <pr>` green — plus a one-shot verbatim log relay to A when that report turns out red. The no-tight-polling rule is trivially satisfied: the manager never polls.
- **Escalation.** Surface blockers (auth failures, repeated stalls, B-flagged-High rejections without evidence) to the user immediately. Do not silently absorb or decide them.
- **Stuck reports.** When an implementer-class subagent reports it is stuck, it must use the canonical stuck-report format in `.zcode/agents/README.md`. A stuck report is never a substitute for the completion criterion: a PR must exist and all its checks must be green.
- **Context budgets.** Each implementer-class phase runs under the hard budget in `.zcode/agents/README.md` (~150k billed input tokens or ~150 requests). When the budget is hit, the subagent checkpoints, pushes, and hands off instead of continuing in a bloated context.
- **Cost discipline.** Model choice per stage comes from config (`model_configs`) only. Price is weighed in every model decision; paid LLM/embedding APIs are accepted in the critical path, but cost is traced per query (AGENTS.md § Cost discipline).

## Anti-patterns

- Re-dispatching the whole workflow because one step failed — resume the specific subagent.
- Respawning a dead subagent from scratch without the respawn intake check — pushed commits, a dirty worktree, or an open draft PR mean the run has a checkpoint to resume from.
- Posting summary text to the PR before verifying individual comments landed.
- Marking the loop done on subagent-reported status without independent `gh` verification.
- Routing review feedback back to A instead of C — the fixer role exists precisely to bring fresh eyes.
