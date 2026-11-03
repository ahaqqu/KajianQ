---
name: board-reconcile
description: Reconcile the KajianQ Kanban board with the tickets' real state — find every drifted card, move it where the evidence settles it, and verify the write-back. Run by hand when the board looks out of sync.
disable-model-invocation: true
source: project
---

# Board reconcile

The board carries each ticket's workflow state; the issue carries its content. The manager writes cards during the loop, so **drift** appears between loops: a ticket closes and its card stays put, a filed ticket never gets a card, a verdict lands while its card still says In QA. This pass is the sweep that restores agreement. It runs by hand, because nothing else can tell that the board has gone stale.

You run as the manager session or the owner. The board has one writer, and a role subagent never runs this pass. The pass changes cards only: issues, labels, PRs, merges and comments stay out of reach, and work whose bookkeeping is missing — a card settled at Done while its issue is still open — is reported, not closed.

The eight states, what each means, and the board API mechanics are canonical in [`manager`](../manager/SKILL.md) § Project board — the ticket state surface. Read that section first in a run; this file adds the audit procedure, the evidence classifier, and the conservative rule that keeps the pass from guessing.

## 1. Read the board and the tickets

Four bulk reads, staged in `.scratch/board-reconcile/` (git-ignored) so a killed pass resumes instead of re-reading:

```sh
mkdir -p .scratch/board-reconcile
gh project field-list 3 --owner ahaqqu --format json > .scratch/board-reconcile/fields.json
gh project item-list 3 --owner ahaqqu --format json --limit 300 > .scratch/board-reconcile/cards.json
gh issue list --repo ahaqqu/KajianQ --state all --limit 1000 \
  --json number,state,stateReason,labels,title > .scratch/board-reconcile/issues.json
gh pr list --repo ahaqqu/KajianQ --state all --limit 1000 \
  --json number,state,mergedAt,reviewDecision,closingIssuesReferences \
  > .scratch/board-reconcile/prs.json
```

`--limit` is not optional: the default returns 30 cards with no warning. A dump is usable only when `items | length == totalCount`; re-read with a larger `--limit` otherwise, and never act on a truncated one. The rest of the read discipline — option ids read fresh from the field list, a write proven by a re-read — is the manager section's. A `missing required scopes [read:project]` failure stops the pass: the refresh is interactive and owner-only.

**Done.** The card dump passes the complete-read proof, and the Status options and their ids are in hand.

## 2. Classify the cards

The audit set is every card not in Done, every Done card whose issue is still open, every Done card whose issue closed without delivery, and every open issue with no card. **Done cards closed as completed are consistent by definition and are not read again** — the settled majority costs nothing, which is what keeps the pass cheap.

Classify by the evidence, never by the current column. The evidence is the issue's state and close reason, the closing PRs that name it, and — only where the table sends you — whether a QA verdict has been recorded. The first matching row wins, and a card that starts with no Status re-enters the table once Backlog is applied:

| Evidence about the ticket                                  | Card now                        | Settles at                                                                                                        |
| ---------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| no Status                                                  | —                               | **Backlog**, then classify again                                                                                  |
| issue closed as completed                                  | anything but Done               | **Done**                                                                                                          |
| issue closed as not planned                                | anything but Cancelled          | **Cancelled** — a closure without delivery, and never Done                                                        |
| issue open; a PR closing it is merged; no verdict recorded | anything but Done               | **In QA**                                                                                                         |
| issue open; a PR closing it is merged; verdict recorded    | anything but Done               | **Done** — and report the closure owed                                                                            |
| issue open; the card says Done                             | Done                            | **In QA** when the ticket records no verdict; **Done** plus the closure owed when it does                         |
| an open PR closes it; the card is parked                   | Backlog, Ready, Done, Cancelled | **In review**, or **Waiting for merge** when the PR is approved and its checks are green (`gh pr checks` exits 0) |
| issue open; the card says Cancelled                        | Cancelled                       | **Backlog**, then classify again — the ticket is live again                                                       |
| no routing label, or not exactly one type label            | Ready                           | **Backlog** — not triaged                                                                                         |

A merged PR belongs to the ticket when it names it in `closingIssuesReferences`. A PR that merely mentions the ticket is partial progress and settles nothing, so the pass reads no PR bodies and runs no search per card.

Two bounded reads feed the rows that need them: `gh issue view <n> --json comments` for the cards whose issue is open and whose closing PR merged, or whose issue is open while the card says Done; and `gh pr checks <n>` for the open PRs. Both sets are small; neither ever runs over the whole board.

Most cards no row matches are simply consistent: In progress with no PR is work in flight, and triaged Ready is a ticket parked on a decision — the pass leaves them alone and says nothing. A card is **unsettled** only when its column claims progress the evidence cannot show — In review or Waiting for merge with no open PR, In QA with no merged closing PR. It keeps its column and joins the report, so the suspicion is visible without becoming a move. **Move nothing on suspicion.**

**Done.** Every card in the audit set carries exactly one of: a target column, a consistent column, unsettled with its missing evidence named, or closure owed. A card carrying none is unfinished.

## 3. Move the drifted cards

Write the plan to `.scratch/board-reconcile/plan.json` first — issue, from, to, evidence — then apply it in one script. One call per card:

```sh
gh project item-edit 3 --owner ahaqqu \
  --url https://github.com/ahaqqu/KajianQ/issues/<n> \
  --field Status --value "<column>"
```

An open issue with no card is added first (`gh project item-add 3 --owner ahaqqu --url …`), then classified like any other card. Beyond a handful of moves the pass is a mechanical background job, so a kill loses the current batch and the plan file says where to resume.

**Done.** Every planned move exits 0. An unresolved id is re-read from the fresh dump and retried; it is never a skip.

## 4. Verify and report

Re-read the card dump and re-prove it complete. A move is done only when the card reads its target column in that re-read; a mismatch is retried once with a re-read option id, then reported as failed rather than quietly accepted.

Report to the owner, in this order:

- **Moved** — one line per card, `#N from → to (why)`, grouped by target column.
- **Closure owed** — cards settled at Done whose issue is still open, with the verdict that justifies the column. Each needs a ticket closure, which the pass does not perform.
- **Unsettled** — cards whose column the evidence contradicts but cannot settle, each with the missing evidence.
- **Column counts before → after**, one line, so the sweep's size is visible.

**Done.** The re-read meets the complete-read proof, every move reads back at its target, and no card in the audit set is unaccounted for in one of those four sections.
