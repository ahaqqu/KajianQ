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
- **DSH** → `.agents/skills/manager/DSH-ADAPTER.md`

Each adapter carries only its own harness's mechanics — spawn, continue, results, model routing, workspace, and session facts — stated as instruction. Two rules are harness-neutral and live **only here**, so the adapters point at them instead of restating them: the **subagent todo duty** (dispatch-prompt requirement in step 1; canonical bullet in Reliability & supervision) and the **fix-then-re-review trigger** (Reliability & supervision).

## Non-negotiables

- **Never report a step done without observable evidence**: a PR URL that exists, comments present on the PR, `gh pr checks` output green. Subagent prose alone is not evidence.
- **Never paper over failure.** If a subagent stalls or CI stays red after retries, escalate to the user with the concrete blocker. A flaky or silently-skipped step is unacceptable.
- **Relay CI failures verbatim.** When CI goes red on A's PR, send A the raw failing-check logs. A fixes; you do not debug.

## Workflow

### 0. Intake

- Establish the task scope: what the change is, what done looks like, and the target branch (default `main`).
- If the task is underspecified, grill the user (`grill-with-docs`) or escalate before spawning A. A clear task up front prevents flaky downstream runs.

### 1. Dispatch A (implement)

Choose the implementer type using the **dispatch decision** below, then spawn it in the background (per your harness adapter). The prompt must state: the task, the Definition of Done in `AGENTS.md`, that **A owns CI green** — it watches its own checks and iterates on red until green, reporting completion only when the criterion **PR URL + `gh pr checks` green** holds (canonical statement: the CI protocol in Reliability & supervision; duplicated here because the dispatch prompt is what A actually reads) — that it must apply `guided-implementation`, the **worktree it must work in** (`.worktrees/<slug>` on branch `agent/<slug>`, per Workspace isolation below), and the **subagent todo duty** (canonical bullet in Reliability & supervision). The todo clause must say: maintain your own `todo_write` plan with whole-list replacement each call, exactly one item `in_progress` unless parallel work is genuinely in flight, and an update at every phase boundary (before a long gate run, at a handoff, when scope changes). State the constraint explicitly so it is not read as "inherit the manager's list": the list is **per-session and turn-scoped** — never inherited from the dispatcher, cleared at each `turn/start` — so each subagent owns its own list and keeps it current within its turn. A subagent that never writes one is invisible to the owner; that is the defect this duty closes. For a `senior-implementer` dispatch, also require it to lead with the invariant and design-for-verification statement.

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

Spawn the reviewer role (per your harness adapter) in the background. It applies the `code-review` skill (the single review entry point — for a code-touching PR the thermos depth is mandatory) and posts the itemized findings via `thermos-with-comments`, running both thermo passes itself. Its prompt must hand it the PR number/URL and require its completion criterion: **every item posted as a review comment + summary comment present**. Carry the todo duty into B's prompt too (canonical bullet in Reliability & supervision), scoped to its pass structure — one list item per pass and per posting/verification step.

**Completion criterion (verified):** `gh pr view <pr> --comments` shows the summary comment (contains "Thermos review") and at least as many review comments as items in B's returned report.

### 4. Dispatch C (fixer)

The fixer reuses A's worktree (`.worktrees/<slug>`) if it still exists, or adds a fresh one from the existing branch (`git worktree add .worktrees/<slug> agent/<slug>` — no `-b`). State the worktree path in C's dispatch prompt, and carry the todo duty into it (canonical bullet in Reliability & supervision).

Send C: B's full itemized report (verbatim) including each item's posted review-comment ID, and these instructions:

1. For each item, post its disposition as a **threaded reply on that item's original review comment** — never a separate PR/issue comment or a reply on the summary thread: `gh api repos/{owner}/{repo}/pulls/<pr>/comments/<comment_id>/replies -f body=…` (the route requires the PR number in the path — the ID-only form `pulls/comments/{id}/replies` 404s). The reply body is **accept** or **reject** plus one-sentence reasoning. For a **PR-level (issue-comment) finding**, post the disposition as a standalone issue comment referencing the finding ID — GitHub has no threaded-reply route for issue comments.
2. **Verify every reply landed** before reporting: `gh api repos/{owner}/{repo}/pulls/<pr>/comments` shows each finding's comment with a reply whose `in_reply_to_id` matches that finding's comment ID. A disposition that is not a threaded reply on the original comment does not count; a PR-level finding is verified by its standalone issue comment referencing the finding ID.
3. For every accepted item, apply the fix; re-run `bun run check && bun run test && bun run size-limit` locally.
4. Push fixes to the same branch, then post a **resolution report** as a PR comment listing each item ID, its disposition, the threaded reply (comment ID), and the commit that fixed it (for accepted items). Post it **before** watching CI and update it in place (`gh api -X PATCH repos/{owner}/{repo}/issues/comments/<comment_id> --input <json-payload-file>`) once checks settle — an interrupted session loses whatever comes last, so the report must already be on the PR.
5. Keep CI green; iterate on red until `gh pr checks <pr>` is green for the head commit.
6. Report back: PR URL, item dispositions, final `gh pr checks` status.

### 5. Verify C's fix loop

- Wait for C's resolution report comment (verify with `gh pr view --comments`).
- Verify `gh pr checks <pr>` is green after C's fixes.
- Apply the **fix-then-re-review trigger** (canonical bullet in Reliability & supervision) to C's fix commits. When it fires, dispatch a scoped re-review of the fix-commit range (reviewed head → new head) before recommending merge; the recommendation waits for that re-review to complete. When it does not fire, record in the final summary why the new head did not need one (e.g. docs/typo/format-only fixes).

### 6. Summarize and recommend

Produce the final user-facing summary:

- **What happened**: scope, what A implemented, the PR URL, CI history (red→green transitions if any).
- **Dispatch rationale**: which implementer type you spawned for this ticket (implementer vs senior-implementer) and why (label or judgment).
- **Review outcome**: B's recommendation, item counts by priority, and the final accept/reject disposition per item.
- **Cleanup**: after the PR merges or closes, remove A's worktree and C's if it created a separate one with `bun run worktree:clean` **run from the main checkout** — that script owns the rule (it scans `.worktrees/<slug>`, expects branch `agent/<slug>`, and always keeps unmerged work; `--dry-run` reports first). Never hand-roll `git worktree remove`. You own this; A and C cannot observe the merge (see Workspace isolation).
- **Workflow observations**: what went smoothly, what stalled, what required retries.
- **Next-step recommendation**: e.g. merge — only when the current head is reviewed: B's compliance + thermos passes ran on head `<sha>` and no later fix triggered a scoped re-review, or the forced scoped re-review of the fix commits completed clean (step 5) — follow-up tickets, or escalating a rejected-High to the user.
- **Workflow improvement suggestion**: at least one concrete change to this skill, the role agent files, or the relay protocol that would have made this run faster or more reliable. This is a standing duty of the manager — if everything went perfectly, say so and skip.

### 7. Post-merge CI check

After the owner merges, one-shot verify the post-merge workflows on `main` are green for the merge commit (`gh run list --workflow <post-merge workflow>` filtered to that commit — e.g. the `Staging` workflow). On red, relay the failing log to the user immediately — never silently absorb it: a PR green before merge can still break main. Step 6's cleanup duty moves behind this check: remove worktrees only once the post-merge runs are verified or the failure is relayed.

## Reliability & supervision

- **Subagent results.** Capture each spawn's agent/subagent id. Continue a running child with your adapter's continue mechanism. Read a child's result from its report/settle notice — not from a transcript-style output tool (your adapter documents the specifics).
- **Objective verification over prose.** Every awaited artifact is verified independently (`gh pr view`, `gh pr checks`, `gh api`), not trusted from a subagent's message.
- **Workspace isolation.** Every implementer-class dispatch (and any dispatch that will run `git` state-changing operations — commit, branch, push, checkout) must work in its own `git worktree` under the repo's committed `.worktrees/` directory, never in the session's shared checkout: run `git worktree add .worktrees/<slug> -b agent/<slug> origin/main` from the main checkout. `/tmp` is not an option: on DSH it is per-invocation, not persistent (see the DSH adapter) — and `.wt/` must not be used: `.worktrees/` is the one in-repo convention, committed to `.gitignore` and understood by `bun run worktree:clean`. Parallel dispatches in one tree switch each other's branches mid-run and corrupt each other's diffs. State the worktree path in the dispatch prompt and require the subagent to verify `git branch --show-current` prints `agent/<slug>` before every state-changing `git` operation. Cleanup duty is yours: when the PR merges or closes, run `bun run worktree:clean` **from the main checkout** — it removes `.worktrees/<slug>` only when the branch is disposable (PR merged, already in `origin/main`, or no unique commits), keeps unmerged work, and skips dirty worktrees without `--force`; use `--dry-run` to see its verdicts first. Never hand-roll `git worktree remove`. A fresh worktree deliberately does **not** carry the shared checkout's uncommitted state — that exclusion is the isolation boundary, not a defect.
- **Fixer worktree.** C reuses A's worktree (`.worktrees/<slug>`) if it still exists, or adds a fresh one from the existing branch (`git worktree add .worktrees/<slug> agent/<slug>` — no `-b`). The manager states the worktree path in C's dispatch prompt.
- **Stall rule.** Configurable: `STALL_MINUTES` (default 30). If a background subagent produces no observable artifact within that window, send one "status?" ping via the continue mechanism. On continued stall, respawn the subagent fresh (new id) after the respawn intake check below, re-issuing the original prompt when no checkpoint exists. After two stalled attempts, escalate to the user.
- **Respawn intake.** Before respawning fresh for a task whose earlier attempt died (stall respawn, orphan, provider failure, session kill), first recover prior progress so the respawn resumes instead of re-burning exploration from zero. Check, in order — no PR number is needed for any check, because the task branch is known from the dispatch: (1) **pushed commits** on the task branch — `git fetch` then `git log origin/agent/<slug>`; (2) **leftover worktree with uncommitted progress** — `git worktree list` for a `.worktrees/<slug>` path, then `git -C .worktrees/<slug> status --short` (a leftover worktree is recoverable state, not garbage; a dirty one means the dead attempt was mid-edit); (3) **open draft PR** — `gh pr list --head agent/<slug> --state open --json number,title,isDraft`. Only after (3) locates a PR, read it with `gh pr view <pr>` for its head commit and details. Whatever you find is the **last checkpoint**: the respawn prompt must state it explicitly (branch `agent/<slug>`, head commit, worktree path with dirty files, PR URL) and instruct the subagent to continue from it — reattach the existing worktree or add a fresh one with `git worktree add .worktrees/<slug> agent/<slug>` (no `-b`: the branch already exists from the dead attempt; `-b` is only for creating the branch fresh at first dispatch), inspect the checkpoint before re-exploring, reuse existing commits, and push to the same branch/PR. Only when all three checks come up empty does the respawn get the original from-scratch prompt.
- **CI protocol.** **A owns CI green; C owns keeping it green after review fixes; the manager verifies once.** The implementer-class role (A) watches its own PR's checks and iterates on red until green — with checkpoint commits — and reports completion only when all checks pass; the fixer (C) does the same for review fixes. This bullet is the canonical statement of the split, duplicated in A's dispatch prompt (step 1) and the fix-loop relay (step 4). The manager never monitors, watches, or schedules anything for CI: no `gh pr checks --watch`, no per-PR scheduled automation, no polling. The manager's only CI action is one-shot verification at A's completion report (step 2) and at C's completion report (step 5) — `gh pr view <pr>` open + `gh pr checks <pr>` green — plus a one-shot verbatim log relay to A when that report turns out red. The no-tight-polling rule is trivially satisfied: the manager never polls.
- **Escalation.** Surface blockers (auth failures, repeated stalls, B-flagged-High rejections without evidence) to the user immediately. Do not silently absorb or decide them.
- **Stuck reports.** When an implementer-class subagent reports it is stuck, it must use the canonical stuck-report format in `.zcode/agents/README.md`. A stuck report is never a substitute for the completion criterion: a PR must exist and all its checks must be green.
- **Subagent todo plans (canonical).** Every dispatched role maintains its plan in its own `todo_write` task list: whole-list replacement each call (there is no partial update), exactly one item `in_progress` at a time unless parallel work is genuinely in flight, and an update at every phase boundary — before a long gate run, at a handoff, and when scope changes. The list is **per-session and turn-scoped**: it is never inherited from the manager and is cleared at each `turn/start`, so each subagent creates and owns its own list and keeps it current within its turn (DSH's task list is single-owner — see the DSH adapter). The manager states this duty in every role dispatch prompt (A in step 1; B in step 3; C in step 4), and each role file carries it for harnesses with native role agents (the reviewer's scoped to its pass structure). The list is progress telemetry for the owner — valuable, but never a substitute for the objective completion criterion (a PR exists and all its checks are green).
- **Fix-then-re-review (canonical).** A review pass covers exactly the head it ran on; a fix that lands after it makes that artifact stale. **A scoped re-review of the fix commits is forced before merge** when the fix touches any of: (a) a **High-priority finding** — any fix made in response to an item the reviewer rated High; (b) an **engine seam** — `Provider`, `RagStore`, `ObjectStore`, a pipeline-stage interface, or `runPipeline` wiring; or (c) a **contract** — `packages/contracts` schemas/types or a `/v1` route contract. The re-review is scoped to the diff from the reviewed head to the new head (`git diff <reviewed-head>..<new-head>`), dispatched as a fresh reviewer (or the same reviewer resumed) with that range as its scope, and it posts its findings under the same itemized contract as any pass, naming the range it covered. Merge may be recommended only when the current head carries a review artifact that covers it: after a forced re-review, step 6 waits for it. A fix outside those triggers (docs-, typo-, or format-only) does not force one; the manager records that judgment in the final summary.
- **Context budgets.** Each implementer-class phase runs under the hard budget in `.zcode/agents/README.md` (~150k billed input tokens or ~150 requests). When the budget is hit, the subagent checkpoints, pushes, and hands off instead of continuing in a bloated context.
- **Cost discipline.** Model choice per stage comes from config (`model_configs`) only. Price is weighed in every model decision; paid LLM/embedding APIs are accepted in the critical path, but cost is traced per query (AGENTS.md § Cost discipline).

## Anti-patterns

- Re-dispatching the whole workflow because one step failed — resume the specific subagent.
- Respawning a dead subagent from scratch without the respawn intake check — pushed commits, a dirty worktree, or an open draft PR mean the run has a checkpoint to resume from.
- Posting summary text to the PR before verifying individual comments landed.
- Marking the loop done on subagent-reported status without independent `gh` verification.
- Routing review feedback back to A instead of C — the fixer role exists precisely to bring fresh eyes.
- Recommending merge on a review artifact for a superseded head — a fix after the reviewed head forces the scoped re-review when it touches a High finding, an engine seam, or a contract (see Fix-then-re-review).
- Dispatching a role without the todo duty or its worktree path in the prompt — the subagent then works invisibly and in the wrong tree (see Subagent todo plans, Workspace isolation).
