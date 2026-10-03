---
name: qa-phase
description: Adversarial staging verification of a merged change. Owns the QA-ticket brief the manager writes, the required probe taxonomy (happy / non-happy / boundary, neighbouring behaviour, the adversarial persona), the falsification rule for gate-affecting changes, and the verdict-with-evidence report contract. Reach for it when classifying a change, writing a QA ticket, or running the QA phase.
source: project
---

# QA Phase

A merged change with a green `Staging` workflow has proven that the deploy took and the smoke subset passed — nothing more. The smoke is five stratified Golden Set questions plus three host checks, so a runtime change on any other code path can ship green and unfixed. **The QA phase is the step that turns "the workflow is green" into "the issue is solved"** — or into an honest `not verified`.

The manager owns the decision and the ticket; the `qa` role agent runs the probes and reports the verdict. This skill is the contract both sides answer to.

## Three shapes — every change is classified

A change is classified before its PR merges, and the manager records the decision either way (a `QA phase: not needed because …` line in the final summary counts as the record).

| Change                                                                   | Shape              | What verifies it                                                                                                 |
| ------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Tests-only, scripts, docs, skills, agent files, CI metadata              | **Inert**          | Nothing — no QA phase. Record why: the change cannot alter deployed behaviour.                                   |
| Eval scorers, fixtures, smoke selection                                  | **Gate-affecting** | **Falsification** — does the gate still fail when it should? Staging user-behaviour probing cannot judge a gate. |
| Routes, chat pipeline, prompts, retrieval, contracts, migrations, web UI | **Runtime**        | **Full staging QA**, adversarial persona included.                                                               |

The middle shape is the one that gets mistaken for the third. A gate-affecting change ships no user-visible behaviour to probe, and a healthy answer from staging says nothing about whether the gate can still go red — so its QA phase is the gate's own falsification, written as a QA ticket with a mutation observable (`the gate must fail on <defect>` — the defect classes the ticket names, e.g. an ungrounded non-refusal) instead of a user observable.

The classification is a judgement about **what the change can break**, not about its diff size: a one-line prompt edit is runtime; a large test-suite refactor is inert.

## The QA ticket (the manager writes it)

The ticket is the QA brief, and it carries all of:

- **The observable that proves the issue is solved in staging** — a named Golden Set question passing, a route's response, a trace field present, a frame rendered. Name it concretely enough that a probe either meets it or does not.
- **The mutation set, for a gate-affecting change** — the defect classes that must redden the gate (an ungrounded non-refusal, an over-refusal, a fabricated citation, a question the selection must include — whatever the change touches), named by the manager here, or an explicit delegation of the choice to the QA agent here with the reason. The QA agent may extend the set; the promised set is the manager's, and a placeholder is not a mutation set.
- **Reachability, confirmed before the observable is promised.** Check the smoke subset actually selects the observable (`packages/eval/src/smoke-subset.ts` is deterministic — read what it picks), and that the merge triggers a `Staging` run at all (a docs-path-only push does not). When the observable is outside the subset, widen that run with the existing `workflow_dispatch` `eval_smoke_size` input or add a targeted check to the ticket's probe list — a promise the deployed run cannot reach is not a QA ticket.
- **The blast radius** — what else sits on the changed code path: the neighbouring stages, the other questions the same scorer judges, the other routes that share the handler, the UI that renders the changed frame.
- **The surfaces to probe** — routes, UI flows, persisted traces, SSE frames, the refusal/answer boundary, the rehydration endpoint.
- **The abuse angles relevant to this change**, named from the taxonomy below rather than left to the QA agent's imagination.
- **The environment and the run being verified** — staging, the merge SHA, the `Staging` run id whose deploy carries it.
- **The spend cap** for the run, in micro-USD. The smoke job's cap is $1 per run (ADR-0034); a QA ticket defaults to that and may set it lower, never higher without the owner. **That number is a _recorded_ cap, not a money bound.** It accumulates the same `costMicroUsd` records the store holds — the ~1000x-low ones (#296; see _Spend_ below) — so a "$1" cap aborts at roughly $1,000 of real spend. Until #296 lands, what bounds real spend is **probe discipline**: the smallest probe set that proves the observable and its blast radius.

## Probe taxonomy (required, not optional)

Every QA ticket's probe list covers these classes; a class that genuinely does not apply is named in the ticket with its reason.

- **The issue's own acceptance criterion, reproduced in staging.** The ticket's observable, probed exactly as the acceptance criterion words it.
- **Neighbouring behaviour** — everything else on the changed code path, not just the symptom in the ticket. If a scorer changed, probe the questions it judges; if a route changed, probe its siblings and its rehydration path.
- **Happy path, non-happy path, and boundary** — empty input, oversized input, malformed input, missing fields, the en↔id locale switch, timeouts, partial failures, a second turn in the same session.
- **The adversarial persona — a user who abuses or hacks the system.** At minimum, for this product: prompt injection through the query or the retrieved corpus to force an ungrounded or dated answer or to leak the system prompt (**the query arm stays a QA probe; the corpus arm is a local falsification harness, not a QA probe — #294**, per _Corpus-injection belongs to a harness_ below); forcing a fabricated citation past the validator and the citations frame; the trap/refusal boundary and the dhaif-grade warning; madzhab-policy bypass attempts; session and token abuse (another session's id, replayed tokens, reading traces or feedback across sessions); erasure-path abuse (`DELETE /v1/auth/me`) against the retention claims; cost and rate abuse (burning the paid budget, rapid-fire queries, the ADR-0041 rate limits); malformed SSE/frame tampering and the UI's rendering of hostile content; and anything the specific change may have impacted.

Two probes of the same class with the same mechanism are one probe. The taxonomy is a floor: a change whose blast radius suggests an angle the list does not name gets that probe too.

## Gate-affecting changes: falsify the gate

A change to an eval scorer, a fixture, or the smoke selection is verified by **mutation** — the gate must still go red when it should:

1. Take the gate's live observable from the ticket (the question, the scorer dimension, the selection rule).
2. Take the mutation set from the ticket — the defect classes the manager named, or the choice the ticket explicitly delegated to you. You may extend the set, but the promised set is the manager's; the report names the mutations you instantiated.
3. Reproduce the gate's failure path against the deployed or committed artifacts without shipping the defect: re-score the recorded evidence, or run the scorer against the known-bad shape, and show that `passed: false`.
4. Show the unchanged good case still passes, so the gate was loosened only where the ticket says.

A staging smoke whose questions all pass is **not** falsification evidence: it shows the gate can pass, never that it can still fail. If the mutation cannot be reproduced with the deployed artifacts, the verdict is `blocked` with the exact command that failed — not `verified`.

## The report (the QA agent posts it)

Post the report as a comment on the QA ticket, and link it from the release or PR that carries the change. It contains:

- **The verdict** — `verified`, `not verified`, or `blocked`.
- **The environment and run identifiers**: staging base URL, merge SHA, `Staging` run id, and the ids of what the probes produced (trace ids, message ids, response bodies).
- **Every probe, one entry each**: what was probed, the request, the observed result, and what it proves about the observable or the blast radius. A probe that passed and a probe that failed are reported the same way.
- **The findings**: each real defect as its own ticket, linked. The QA agent does not fix code.
- **The spend consumed**, against the cap — the sum measured per _The two authorized store reads_ (recorded cost; its calibration is under review, #296), not an estimate. A run that could not read it says so and reports no figure rather than a derived one.

The verdict is the only thing that closes a QA-needed change: `verified` when the observable holds and no blast-radius defect survived, `not verified` when a probe contradicted the acceptance criterion, `blocked` when the environment, the run, or the cap stopped the probes. "The workflow is green" is not a verdict, and a partially-run probe set never rounds up to `verified` — name the probes that did not run and why.

## The verdict and the board

**The QA phase owns the verdict; the manager owns the card move.** `In QA` is the card of a merged and deployed change whose verdict is still pending, and the manager's transition rules are what take a card out of it — on the verdict the QA role posts, never on a move the role makes. Roles report artifacts and do not touch the board (`.zcode/agents/README.md`); the `manager` skill's § Project board — the ticket state surface is canonical for the states, their transitions, and what **Done** means.

Each verdict implies one card state:

- **`verified`** — the observable holds and no blast-radius defect survived. This is the verdict the card's move to **Done** records.
- **`not verified`** — a probe contradicted the acceptance criterion. The card stays in **In QA**, where the column names the work outstanding: the failing probe goes to the user verbatim, every defect becomes its own ticket through the normal implement → review loop, and the change is not finished.
- **`blocked`** — the environment, the run, or the cap stopped the probes. The card stays in **In QA** and the change is not finished; the verdict carries the exact command that failed in place of a verification the run did not produce, and the probes re-run when the blocker clears.

A non-`verified` verdict is never withheld for the card's sake — post it with the same per-probe evidence and let the manager's transition rules take the card from there.

## Safety rails

- **Staging only.** The one deployment is the `staging` environment and it **is**
  the public URL (`https://kajianq.ahaqqu.com`) — no production deployment is
  provisioned (ADR-0044 amendment, 2026-10-03), so there is no second
  environment a probe could reach or be pointed at. **Never a prod dispatch**
  either: an operator deploy through the `prod` environment's approval gate
  stays outside this role's reach, and with no production provisioned it would
  land on the same box. The rails below are what bound the blast radius.
- **Anonymous sessions only**, no real user data, and every session the run creates is erased with its own token (`DELETE /v1/auth/me`) before the report is posted. Keep each token in a **durable scratch path** until the run ends — a per-invocation `/tmp` loses it between tool calls, and erasure needs that token: a session whose token is gone cannot be deleted through the API. Disclose any session you could not erase in the report, with its `sessionId`, what it contains (e.g. no messages), and its expiry under the 30-day inactivity reclamation.
- **Read-only on the repo**: comments and finding tickets yes, commits/branches/merges/closures no.
- **The store read is SELECT-only, subject-scoped, with two purposes.** Through the documented staging tunnel (`docs/VPS-OPERATIONS.md` §2.8, port 15433, password at `~/.config/kajianq/db-password`) you may run `SELECT` queries with `default_transaction_read_only=on` set on the connection, over (a) cost aggregates on `answer_traces` scoped to the anonymous `user_id`s the run created and (b) the persisted traces of those same sessions — nothing else, and no other subject's rows. **Never `SELECT` `chat_messages` content, `feedback` free text, or another subject's `trace` JSONB**; a query that is not one of the two purposes is out of posture whatever it returns. Writes, migrations and snapshots are outside the grant. The connection option is a discipline and an accident-guard, **not** a privilege boundary — the credential is the application's own role, it can write, and the GUC is `PGC_USERSET` (ADR-0048 amendment, 2026-09-28) — so keeping the read a read is yours, not the database's. Read the spend and the probe's trace events **before** erasing the sessions: erasure cascades both away.
- **Nothing destructive** against the corpus or the store; no paid ingest; no money-spending operation past the ticket's cap.
- **Report the spend actually consumed** under the cap, measured per _The two authorized store reads_ — **recorded** cost, labelled as such (#296).

## The two authorized store reads

The public API carries neither the spend nor the reviewer/pre-gate events, so both are read from the store under the grant in the safety rails — scoped to the sessions the run created, and to nothing else. Reach it through the documented ssh tunnel:

```bash
# docs/VPS-OPERATIONS.md §2.8 — keep this shell open for the run
ssh -N -L 15433:127.0.0.1:5432 <user>@<host>
# then, for every query — the password stays out of argv and shell history:
export PGPASSWORD="$(cat ~/.config/kajianq/db-password)"
PGOPTIONS='-c default_transaction_read_only=on' psql \
  -h 127.0.0.1 -p 15433 -U kajianq -d kajianq -c '<SELECT>'
```

(The operator runbook's own §2.8 snippet still shows the URL form; that operator-side shape is #297, and it is not the pattern to copy here.)

### Spend

Cost lives per call on the persisted trace's events: `answer_traces.trace` is the `Trace` contract verbatim, and each event may carry `cost.costMicroUsd`. Sum it over the run's own sessions — one anonymous session is one `user_id`.

**The run's scope is the `user_id`s it created.** Each is the `userId` in the `POST /v1/auth/anonymous` response (`AnonymousSessionSchema`, `packages/contracts/src/auth.ts`); the SSE frames carry no user id (`ChatMetaSchema`), so nothing a probe reads back yields it — keep each one in the same durable scratch path as its token. A run that lost them cannot scope the query: say the spend was not read and give no figure.

```sql
-- the run's own total: its own sessions only, bounded at both ends
SELECT coalesce(sum((e->'cost'->>'costMicroUsd')::bigint), 0) AS spend_micro_usd
FROM answer_traces t
CROSS JOIN LATERAL jsonb_array_elements(t.trace->'events') AS e
WHERE t.user_id = ANY ('{<the run''s anonymous user ids>}'::uuid[])
  AND t.created_at >= '<run start, timestamptz>'
  AND t.created_at < '<run end, timestamptz>'
  AND e->'cost'->>'costMicroUsd' IS NOT NULL;
```

A `user_id`-less sum over `created_at >= '<run start>'` was measured at **537 micro-USD** in #295's review, against a store whose busiest single subject held 248 and whose lifetime total was 3,108 — it aggregates every other subject's rows. It is **not** the run's spend, it is not one of the two purposes, and no such figure goes in the report.

Report the sum with the cap. A run whose spend cannot be read — tunnel down, ids lost — says exactly that in the report and gives no figure; the cap is then enforced by probe discipline alone, and the report must not imply a measurement it did not take.

**The figure is _recorded_ cost, and its calibration is under review.** The sum is what the pipeline wrote from the `models.json` prices, and those values are ~1000x below the unit that file declares (its own `cheap` comment names $0.14/$0.28 per MTok, while `in: 140` computes an 8K-token call at 1.12 micro-USD against SPECS §5's ~1,300), so the store's ~2-micro-USD-per-event records understate real spend by the same order. Reconciliation is #296. Until it lands, report the sum as **recorded** cost: a lower bound whose trend is meaningful, whose absolute value cannot enforce the cap, and never a working budget control.

**The cap's own number shares that understatement**, so the reframing does not stop at the report: the cap accumulates the same records — ADR-0034 decision 2's single `Budget` over the per-event `costMicroUsd` (`packages/eval/src/budget.ts`, `harness.ts`) — and a "$1" cap therefore aborts at roughly $1,000 of real spend. The $1 *recorded* cap is not a $1 _money_ bound until #296 lands, and no text may read it as one. Until then, **probe discipline is what bounds real spend**: probe the smallest set that proves the observable and its blast radius, and say in the report that the cap did not bind it.

### Reviewer/pre-gate span events

The SSE `trace` frame is the user-facing projection (`sources` + `technical`) and carries no reviewer/pre-gate events by contract, so read them from the persisted trace. The trace id must be one the run's own probes produced — the query carries the owner check as well, so an id from another subject cannot be read at all. The pre-gate records a `decision` event (`detail.purpose = 'citation_support'`) whose `detail.items` is **one entry per citation position** in the draft — never a merged span — with `key` the normalized label and `score` the vendor's Noul answer. That array is the per-citation span evidence:

```sql
SELECT e->>'kind' AS kind,
       e->'detail'->>'purpose' AS purpose,
       e->'detail'->>'outcome' AS outcome,
       e->'detail'->'items' AS items,
       e->'detail'->>'grounded' AS grounded
FROM answer_traces t
CROSS JOIN LATERAL jsonb_array_elements(t.trace->'events') AS e
WHERE t.id = '<trace id from the SSE meta frame>'::uuid
  AND t.user_id = ANY ('{<the run''s anonymous user ids>}'::uuid[])
  AND e->>'kind' IN ('decision', 'review')
ORDER BY (e->>'at')::bigint;
```

Read the result against the outcome, not against the event you expected:

- `outcome = 'skip'` — every citation cleared, the paid reviewer was skipped, and **no `review` event exists on that trace**. The `decision` event's `items` is the span-level evidence, and the absent `review` event is the pre-gate working as designed.
- `outcome = 'escalate'` — a `review` event follows, whose `detail.grounded` names the retrieved labels the answer cited.
- `reason = 'no_items'` — the draft carried no citation, so nothing could be judged (`items: []`). A probe written for the pre-gate picks a draft citing at least two labels and reads this `decision` event; a no-citation draft carries no spans to show.

### Corpus-injection belongs to a harness, not the QA role

The adversarial persona names injection through the retrieved corpus. Planting a hostile chunk is a **write**, which the QA posture forbids — the store is the asset the QA phase judges, and the grant above is SELECT-only by posture, not by privilege (see the safety rail). Query-level injection (the same attack carried by the question) stays a QA probe and runs against the deployed surface. The corpus variant belongs in a **local falsification harness**: an implementer or reviewer dispatch inserts one hostile chunk into a scratch or fixture store, runs the pipeline, and asserts the answer is not swayed by it. It is #294.

## Completion criterion

The QA phase is done when the verdict is posted on the QA ticket with every probe's evidence, every defect has its own ticket, the spend is reported against the cap, and every session the run created is **erased or its non-erasure disclosed** (safety rails). Until then the QA-needed change is not finished — and its cleanup does not start.
