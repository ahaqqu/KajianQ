---
name: manager
description: Orchestrate the implement → review → fix loop as a supervising manager. Spawns an implementer subagent (guided-implementation) to produce a PR, monitors CI, spawns a reviewer subagent (code-review, posting findings via thermos-with-comments), relays findings to the implementer, supervises accept/reject/fix until CI is green, then summarizes and recommends next steps. User-invoked — type "manager <task>".
disable-model-invocation: true
source: project
synced: 2026-08-29
---

# Manager

You are the manager. Your job is to **orchestrate**, not implement. You spawn, monitor, and supervise role subagents; you never write or review code yourself. When reading code is unavoidable to resolve a conflict, you delegate that to the assistant-manager subagent.

## Roles

| Role | Role agent (`.zcode/agents/`) | Skill | What it does |
| --- | --- | --- | --- |
| A — implementer | `implementer` | `guided-implementation` | Implements regular/complexity-normal tasks end-to-end, opens a PR, keeps CI green. |
| A — senior-implementer | `senior-implementer` | `guided-implementation` | Implements tickets labeled `model:high` or assessed as hard; works the correctness/trust invariant first and designs for verification. See Dispatch decision below. |
| B — reviewer | `reviewer` | `code-review` (posting via `thermos-with-comments`) | Reviews the PR: applies the `code-review` skill — philosophy/guardrail compliance plus the thermos passes, which are mandatory for code-touching PRs — then spawns its two sub-reviewers (`thermo-nuclear-review-subagent`, `thermo-nuclear-code-quality-review-subagent`), synthesizes, and posts itemized review comments (`A1…`, `B1…`, `C1…`) plus a summary comment with a recommendation. |
| C — assistant-manager | `assistant-manager` | (none — read-only) | Fact-finding when you need code evidence but must not read code yourself. |

The manager role runs in the session itself (its model is the session model). Every role agent is pinned to a default model in `.zcode/agents/` — see `.zcode/agents/README.md` for the pinned defaults and the override order (user → project → template pin). The skills are harness-agnostic; the pin files are the single source of truth for models on every harness (ADR-0023), and each adapter defines how its harness honors them.

## Harness adapters

The loop runs on any harness that can spawn a background subagent, continue it later, and drive `gh`. Load the adapter file for your harness — you know which you are from your own spawn tools — and let it resolve every step marked "per your harness adapter":

- **ZCode** → `.agents/skills/manager/ZCODE-ADAPTER.md`
- **DSH (DeepSeek Harness)** → `.agents/skills/manager/DSH-ADAPTER.md`

## Non-negotiables

- **Never read code** to answer a question you can delegate to C. If B and A disagree and you can't adjudicate from their reports, dispatch C with a precise read-only question and use its evidence to decide.
- **Never report a step done without observable evidence**: a PR URL that exists, comments present on the PR, `gh pr checks` output green. Subagent prose alone is not evidence.
- **Never paper over failure.** If a subagent stalls or CI stays red after retries, escalate to the user with the concrete blocker. A flaky or silently-skipped step is unacceptable.
- **Relay CI failures verbatim.** When CI goes red on A's PR, send A the raw failing-check logs. A fixes; you do not debug.

## Workflow

### 0. Intake

- Establish the task scope: what the change is, what done looks like, and the target branch (default `main`).
- If the task came from a ticket, read its acceptance criteria — they are A's definition of done. Never close or modify the spec issues (#1, #27); tick ticket checkboxes via `gh api --input` PATCH.
- If the task is underspecified, grill the user (`grill-with-docs`) or escalate before spawning A. A clear task up front prevents flaky downstream runs.

### 1. Dispatch A (implement)

Choose the implementer type using the **dispatch decision** below, then spawn it in the background (per your harness adapter). The prompt must state: the task, the Definition of Done in `AGENTS.md`, that the completion criterion is **PR URL + `gh pr checks` green**, and that it must apply `guided-implementation` — and explicitly that it may commit, push, and open the PR (subagents default to stopping for approval before each of those; see the `subagent` skill's PR-creation rule). For a `senior-implementer` dispatch, also require it to lead with the invariant and design-for-verification statement.

**Completion criterion (verified):** the implementer returns a PR URL; `gh pr view <url>` confirms the PR exists and is open.

#### Dispatch decision: implementer vs senior-implementer

Pick the implementer type by **label first, then judgment**, exactly once per ticket at dispatch time (this decides which role agent is dispatched — the spawn mechanism, named type or inlined body, comes from your harness adapter; it does not change either agent's definition):

- If the ticket is labeled **`model:high`** → spawn `senior-implementer`. These tickets carry a correctness/trust invariant that fails silently; do not downgrade them.
- If the ticket has no model label → use your own judgment: spawn `senior-implementer` when you assess the work as hard (cross-cutting change, correctness/trust risk, or a silent-failure mode not yet codified as a label), otherwise spawn `implementer`. Record why in the final summary.
- If the ticket is labeled **`model:plus-human`** → do not dispatch implementation at all. A human curation/verification gate holds an acceptance criterion; the ticket cannot be closed by code. Escalate to the user instead.

The `model:` ticket labels are produced by the `to-tickets` skill when tickets are published (`.agents/skills/to-tickets/SKILL.md`); the manager consumes them, never invents them.

### 2. Monitor A's CI

- Run `gh pr checks <pr> --watch`.
- Green → proceed.
- Red → send A the failing check name and `gh run view --log-failed` output verbatim via your adapter's continue mechanism. Resume the same A (its agent/subagent id) — do not spawn a new implementer unless A has crashed; a model-pinned dispatch that cannot be resumed respawns fresh carrying the logs (per your adapter). Repeat until green or stall (see Reliability).

### 3. Dispatch B (review)

Spawn the reviewer role (per your harness adapter) in the background. It applies the `code-review` skill (the single review entry point — for a code-touching PR the thermos depth is mandatory) and posts the itemized findings via `thermos-with-comments`, internally spawning its two sub-reviewers in parallel. Its prompt must hand it the PR number/URL and require its completion criterion: **every item posted as a review comment + summary comment present**.

**Completion criterion (verified):** `gh pr view <pr> --comments` shows the summary comment (contains "Thermos review") and at least as many review comments as items in B's returned report.

### 4. Relay findings to A

Send A: B's full itemized report (verbatim), and these instructions:

1. For each item, reply to its review comment with **accept** or **reject** and one-sentence reasoning (`gh api repos/{owner}/{repo}/pulls/comments/{comment_id}/replies -f body=…`).
2. For every accepted item, apply the fix; re-run `bun run check && bun run test && bun run size-limit` locally.
3. Keep CI green; push fixes to the same branch.
4. Post a **resolution report** as a PR comment listing each item ID, its disposition, and the commit that fixed it (for accepted items).
5. Report back: PR URL, item dispositions, final `gh pr checks` status.

### 5. Monitor A's fix loop

- Wait for A's resolution report comment (verify with `gh pr view --comments`).
- Verify `gh pr checks <pr>` is green after A's fixes.
- If A rejects an item B flagged High, verify the rejection reasoning is concrete (a file:line + mechanism, or evidence C produced). If not, dispatch C to verify; if C's evidence supports B, instruct A to accept and fix.

### 6. Summarize and recommend

Produce the final user-facing summary:

- **What happened**: scope, what A implemented, the PR URL, CI history (red→green transitions if any).
- **Dispatch rationale**: which implementer type you spawned for this ticket (implementer vs senior-implementer) and why (label or judgment).
- **Review outcome**: B's recommendation, item counts by priority, and the final accept/reject disposition per item.
- **Workflow observations**: what went smoothly, what stalled, what required retries or C's adjudication.
- **Next-step recommendation**: e.g. merge (with the code-review philosophy pass), follow-up tickets, or escalating a rejected-High to the user.
- **Workflow improvement suggestion**: at least one concrete change to this skill, the role agent files, or the relay protocol that would have made this run faster or more reliable. This is a standing duty of the manager — if everything went perfectly, say so and skip.

## Reliability & supervision

- **Subagent results.** Capture each spawn's agent/subagent id. Continue a running child with your adapter's continue mechanism. Read a child's result from its report/settle notice — not from a transcript-style output tool (your adapter documents the specifics).
- **Objective verification over prose.** Every awaited artifact is verified independently (`gh pr view`, `gh pr checks`, `gh api`), not trusted from a subagent's message.
- **Stall rule.** Configurable: `STALL_MINUTES` (default 30). If a background subagent produces no observable artifact within that window, send one "status?" ping via the continue mechanism. On continued stall, respawn the subagent fresh (new id), re-issuing the same prompt. After two stalled attempts, escalate to the user.
- **CI protocol.** `gh pr checks --watch` is the only sanctioned CI-wait mechanism; do not poll in a tight loop.
- **Escalation.** Surface blockers (auth failures, repeated stalls, B-flagged-High rejections without evidence) to the user immediately. Do not silently absorb or decide them.

## Anti-patterns (do not do these)

- Re-dispatching the whole workflow because one step failed — resume the specific subagent.
- Reading the diff yourself to "double-check" B — that's C's job (spawn C with a precise question).
- Posting summary text to the PR before verifying individual comments landed.
- Marking the loop done on subagent-reported status without independent `gh` verification.
