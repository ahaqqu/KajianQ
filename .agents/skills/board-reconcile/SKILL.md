---
name: board-reconcile
description: Reconcile the KajianQ Kanban board with the tickets' real state — find every drifted card, move it where the evidence settles it, and verify the write-back. Run by hand when the board looks out of sync.
disable-model-invocation: true
source: project
---

# Board reconcile

The board carries each ticket's workflow state; the issue carries its content. The manager writes cards during the loop, so **drift** appears between loops: a ticket closes and its card stays put, a filed ticket never gets a card, a verdict lands while its card still says In QA. This pass is the sweep that restores agreement. It runs by hand — the manager session when the board and the tickets disagree, the owner whenever the board looks stale — because nothing else can tell that the board has gone stale.

You run as the manager session or the owner. The board has one writer, and a role subagent never runs this pass. The pass changes cards only: issues, labels, PRs, merges and comments stay out of reach, and work whose bookkeeping is missing — a card settled at Done while its issue is still open — is reported, not closed.

The eight states, what each means, the transition rules and the board API mechanics are canonical in [`manager`](../manager/SKILL.md) § Project board — the ticket state surface. Read that section first in a run, its **Repair transitions** included: this file's classifier only applies the moves named there, and a card it cannot settle is reported rather than moved. What this file adds is the audit procedure, the evidence table, and the conservative rule that keeps the pass from guessing.

## 1. Read the board and the tickets

Five bulk reads, staged in `.scratch/board-reconcile/` (git-ignored) so a killed pass resumes instead of re-reading:

```sh
mkdir -p .scratch/board-reconcile
gh project field-list 3 --owner ahaqqu --format json > .scratch/board-reconcile/fields.json
gh project item-list 3 --owner ahaqqu --format json --limit 300 > .scratch/board-reconcile/cards.json
gh issue list --repo ahaqqu/KajianQ --state all --limit 1000 \
  --json number,state,stateReason,labels,title > .scratch/board-reconcile/issues.json
gh pr list --repo ahaqqu/KajianQ --state all --limit 1000 \
  --json number,state,mergedAt,reviewDecision,closingIssuesReferences \
  > .scratch/board-reconcile/prs.json
gh issue list --repo ahaqqu/KajianQ --state all --limit 1000 --label qa \
  --json number,state,body,comments > .scratch/board-reconcile/qa.json
```

`--limit` is not optional: the default returns 30 items with no warning. A dump is proven complete before it is used. The card dump proves itself, `items | length == totalCount`. The three list dumps carry no `totalCount`, so each is matched against the search API's count for the same query — `gh api 'search/issues?q=repo:ahaqqu/KajianQ+type:issue' --jq .total_count` for `issues.json`, `type:pr` for `prs.json`, `type:issue+label:qa` for `qa.json`. `gh` has no `--paginate` for these lists, so the `--limit` in use is the whole bound: a count that reaches it is re-read above that count, and a count past a few thousand rows stops the pass, which reports the bound rather than act on a partial list. The rest of the read discipline — option ids read fresh from the field list, a write proven by a re-read — is the manager section's. A `missing required scopes [read:project]` failure stops the pass: the refresh is interactive and owner-only.

**Done.** The card dump and the three list dumps meet their completeness proof, and every Status option and its id is in hand from the field read.

## 2. Classify the cards

The audit set is every card not in Done, every Done card whose issue is open or closed not planned, every Done card whose QA ticket records anything but `verified`, and every open issue with no card. **A Done card whose issue closed as completed, that a merged PR closes, and whose QA ticket records `verified` or that no QA ticket names is consistent by definition and is not read again** — the settled majority costs nothing, which is what keeps the pass cheap.

Classify by the evidence, never by the current column. The evidence is the issue's state and close reason, the merged or open PRs that close it, and — only where the table sends you — the verdict on the QA ticket that names the issue. The first matching row wins, and a card that starts with no Status re-enters the table once Backlog is applied:

| Evidence about the ticket                                                                                    | Card now                        | Settles at                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| no Status                                                                                                    | —                               | **Backlog**, then classify again                                                                                                                                         |
| issue closed as not planned                                                                                  | anything but Cancelled          | **Cancelled** — a closure without delivery, and never Done                                                                                                               |
| issue closed as completed; its QA ticket records no verdict, `not verified`, or `blocked`                    | any                             | **unsettled** — the closure contradicts the verdict, or closed without the one it owed                                                                                   |
| issue closed as completed; a merged PR closes it; its QA ticket records `verified`, or no QA ticket names it | anything but Done               | **Done** — delivery is proven, and where a verdict was owed, the completed closure is the record that it was given                                                       |
| issue closed as completed; no merged PR closes it                                                            | anything but Done               | **unsettled** — a completed closure that proves no delivery; report the closure mismatch, never call it Done                                                             |
| issue open; a merged PR closes it; its QA ticket records `verified`                                          | anything but Done               | **Done** — and report the closure owed                                                                                                                                   |
| issue open; a merged PR closes it; its QA ticket records no verdict                                          | anything but Done               | **In QA** — the verdict is still owed                                                                                                                                    |
| issue open; a merged PR closes it; its QA ticket records `not verified` or `blocked`                         | anything but Done               | **In QA** — the column names the work outstanding                                                                                                                        |
| issue open; a merged PR closes it; no QA ticket names it                                                     | anything but Done               | **unsettled** — the open issue says a verdict was owed, and none is readable                                                                                             |
| issue open; the card says Done                                                                               | Done                            | **Done** plus the closure owed only on a `verified` verdict; **In QA** on any other verdict or on a ticket with no verdict yet; **unsettled** when no QA ticket names it |
| an open PR closes it; the card is parked                                                                     | Backlog, Ready, Done, Cancelled | **In review**, or **Waiting for merge** when the PR is approved and its checks are green (`gh pr checks` exits 0)                                                        |
| issue open; the card says Cancelled                                                                          | Cancelled                       | **unsettled** — an open ticket cannot be Cancelled; report it and leave the card                                                                                         |
| no routing label, or not exactly one type label                                                              | Ready                           | **Backlog** — not triaged                                                                                                                                                |

A merged PR belongs to the ticket when it names it in `closingIssuesReferences`; a PR that merely mentions the ticket is partial progress and settles nothing, so the pass reads no PR bodies and runs no search per card.

**A QA verdict lives on the QA ticket, not on the card's own issue.** The QA role posts it there (`qa-phase` § The report) and the manager verifies it there (step 7), so the card's own issue comments are not where this pass looks. The QA ticket carries the `qa` label and names its source issue on a `Source issue: #N` line (`qa-phase` § The QA ticket), which is what makes the `qa` dump the map from a ticket to its verdict: match the issue's number in those lines, read the verdict off the ticket's report comments (`verified`, `not verified`, or `blocked` — `not verified` contains `verified`, so read the longer phrase first), and take the newest ticket when several name the same issue. A ticket with no verdict statement has no verdict yet; an issue no ticket names has no readable verdict. Neither drives a move the evidence does not otherwise support — the card keeps its column and the missing read joins the report.

**The close reason is the only bulk signal of a closure, so it is evidence about delivery, not about the verdict.** For an issue open after a merge the verdict is readable and it decides the column. For a closed one it is not: a completed closure whose delivery a merged PR proves is taken at its word — that is the record the manager closed on, and the pass does not re-litigate a closed issue — while a completed closure that no merged PR proves delivers nothing the reads can show, so the pass will not move a card into **Done** on it and reports the closure mismatch instead; a **Done** card already matching its closure is left alone rather than reversed. `closingIssuesReferences` mirrors the PR description and not the commit message a closure can also use (the manager section's own caveat), so a delivered change may show no closing PR at all — which is why that row is reported, never applied.

One bounded read feeds the open-PR row: `gh pr checks <n>` for each open PR that would settle a parked card, to tell **Waiting for merge** from **In review**. It runs over that set only, never the whole board.

Most cards no row matches are simply consistent: In progress with no PR is work in flight, and triaged Ready is a ticket parked on a decision — the pass leaves them alone and says nothing. A card is **unsettled** only when its column claims progress the evidence cannot show — In review or Waiting for merge with no open PR, In QA with no merged closing PR, any row above that settles at unsettled — and it keeps its column and joins the report, so the suspicion is visible without becoming a move. **Move nothing on suspicion.**

**Done.** Every card in the audit set carries exactly one of: a target column, a consistent column, unsettled with its missing evidence named, or closure owed. A card carrying none is unfinished.

## 3. Move the drifted cards

Write the plan to `.scratch/board-reconcile/plan.json` first — issue, from, to, evidence — then apply it in one script, one `item-edit` per card, every id resolved from the fresh reads; the name form the manager section rules out is not a shortcut here:

```sh
# once, before the loop
project=$(gh project view 3 --owner ahaqqu --format json --jq .id)
fields=.scratch/board-reconcile/fields.json
cards=.scratch/board-reconcile/cards.json
field=$(jq -r '.fields[] | select(.name == "Status") | .id' "$fields")

# per card, $issue and $column from the plan
option=$(jq -r --arg column "$column" \
  '.fields[] | select(.name == "Status") | .options[] | select(.name == $column) | .id' "$fields")
item=$(jq -r --arg issue "$issue" \
  '.items[] | select(.content.number == ($issue | tonumber)) | .id' "$cards")
gh project item-edit 3 --owner ahaqqu --project-id "$project" --id "$item" \
  --field-id "$field" --single-select-option-id "$option"
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
