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

The middle shape is the one that gets mistaken for the third. A gate-affecting change ships no user-visible behaviour to probe, and a healthy answer from staging says nothing about whether the gate can still go red — so its QA phase is the gate's own falsification, written as a QA ticket with a mutation observable (`the gate must fail on <injected defect>`) instead of a user observable.

The classification is a judgement about **what the change can break**, not about its diff size: a one-line prompt edit is runtime; a large test-suite refactor is inert.

## The QA ticket (the manager writes it)

The ticket is the QA brief, and it carries all of:

- **The observable that proves the issue is solved in staging** — a named Golden Set question passing, a route's response, a trace field present, a frame rendered. Name it concretely enough that a probe either meets it or does not.
- **Reachability, confirmed before the observable is promised.** Check the smoke subset actually selects the observable (`packages/eval/src/smoke-subset.ts` is deterministic — read what it picks), and that the merge triggers a `Staging` run at all (a docs-path-only push does not). When the observable is outside the subset, widen that run with the existing `workflow_dispatch` `eval_smoke_size` input or add a targeted check to the ticket's probe list — a promise the deployed run cannot reach is not a QA ticket.
- **The blast radius** — what else sits on the changed code path: the neighbouring stages, the other questions the same scorer judges, the other routes that share the handler, the UI that renders the changed frame.
- **The surfaces to probe** — routes, UI flows, persisted traces, SSE frames, the refusal/answer boundary, the rehydration endpoint.
- **The abuse angles relevant to this change**, named from the taxonomy below rather than left to the QA agent's imagination.
- **The environment and the run being verified** — staging, the merge SHA, the `Staging` run id whose deploy carries it.
- **The spend cap** for the run, in micro-USD. The smoke job's cap is $1 per run (ADR-0034); a QA ticket defaults to that and may set it lower, never higher without the owner.

## Probe taxonomy (required, not optional)

Every QA ticket's probe list covers these classes; a class that genuinely does not apply is named in the ticket with its reason.

- **The issue's own acceptance criterion, reproduced in staging.** The ticket's observable, probed exactly as the acceptance criterion words it.
- **Neighbouring behaviour** — everything else on the changed code path, not just the symptom in the ticket. If a scorer changed, probe the questions it judges; if a route changed, probe its siblings and its rehydration path.
- **Happy path, non-happy path, and boundary** — empty input, oversized input, malformed input, missing fields, the en↔id locale switch, timeouts, partial failures, a second turn in the same session.
- **The adversarial persona — a user who abuses or hacks the system.** At minimum, for this product: prompt injection through the query or the retrieved corpus to force an ungrounded or dated answer or to leak the system prompt; forcing a fabricated citation past the validator and the citations frame; the trap/refusal boundary and the dhaif-grade warning; madzhab-policy bypass attempts; session and token abuse (another session's id, replayed tokens, reading traces or feedback across sessions); erasure-path abuse (`DELETE /v1/auth/me`) against the retention claims; cost and rate abuse (burning the paid budget, rapid-fire queries, the ADR-0041 rate limits); malformed SSE/frame tampering and the UI's rendering of hostile content; and anything the specific change may have impacted.

Two probes of the same class with the same mechanism are one probe. The taxonomy is a floor: a change whose blast radius suggests an angle the list does not name gets that probe too.

## Gate-affecting changes: falsify the gate

A change to an eval scorer, a fixture, or the smoke selection is verified by **mutation** — the gate must still go red when it should:

1. Take the gate's live observable from the ticket (the question, the scorer dimension, the selection rule).
2. In the QA agent's own scratch reasoning, decide the defect the gate must catch (an ungrounded answer, a fabricated citation, an over-refusal, a question the selection must include).
3. Reproduce the gate's failure path against the deployed or committed artifacts without shipping the defect: re-score the recorded evidence, or run the scorer against the known-bad shape, and show that `passed: false`.
4. Show the unchanged good case still passes, so the gate was loosened only where the ticket says.

A staging smoke whose questions all pass is **not** falsification evidence: it shows the gate can pass, never that it can still fail. If the mutation cannot be reproduced with the deployed artifacts, the verdict is `blocked` with the exact command that failed — not `verified`.

## The report (the QA agent posts it)

Post the report as a comment on the QA ticket, and link it from the release or PR that carries the change. It contains:

- **The verdict** — `verified`, `not verified`, or `blocked`.
- **The environment and run identifiers**: staging base URL, merge SHA, `Staging` run id, and the ids of what the probes produced (trace ids, message ids, response bodies).
- **Every probe, one entry each**: what was probed, the request, the observed result, and what it proves about the observable or the blast radius. A probe that passed and a probe that failed are reported the same way.
- **The findings**: each real defect as its own ticket, linked. The QA agent does not fix code.
- **The spend consumed**, against the cap.

The verdict is the only thing that closes a QA-needed change: `verified` when the observable holds and no blast-radius defect survived, `not verified` when a probe contradicted the acceptance criterion, `blocked` when the environment, the run, or the cap stopped the probes. "The workflow is green" is not a verdict, and a partially-run probe set never rounds up to `verified` — name the probes that did not run and why.

## Safety rails

- **Staging only.** Never production, never a prod dispatch.
- **Anonymous sessions only**, no real user data, and every session the run creates is erased with its own token (`DELETE /v1/auth/me`) before the report is posted. Keep each token in a **durable scratch path** until the run ends — a per-invocation `/tmp` loses it between tool calls, and erasure needs that token: a session whose token is gone cannot be deleted through the API. Disclose any session you could not erase in the report, with its `sessionId` and the reason.
- **Read-only on the repo**: comments and finding tickets yes, commits/branches/merges/closures no.
- **Nothing destructive** against the corpus or the store; no paid ingest; no money-spending operation past the ticket's cap.
- **Report the spend actually consumed**, under or over the estimate.

## Completion criterion

The QA phase is done when the verdict is posted on the QA ticket with every probe's evidence, every defect has its own ticket, the spend is reported against the cap, and every session the run created is erased. Until then the QA-needed change is not finished — and its cleanup does not start.
