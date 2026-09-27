# ADR-0048: The QA phase — a manager-gated, adversarial staging verification of a merged change

## Status

Accepted (2026-09-28). Implements **#252**. It adds a fourth role to the
manager-orchestrated workflow (`.zcode/agents/qa.md` + the `qa-phase` skill),
makes the manager's post-merge check a **decision** rather than a workflow
status, and gives the process a verdict it did not have: the issue is solved,
or it is not. It does not relitigate ADR-0021 (the pipeline runner), ADR-0034
(the eval harness and its budget cap), ADR-0039/ADR-0044 (staging is the same
box as production, distinguished by `APP_ENV`), or ADR-0043 (privacy posture).

## Context

- **"Workflow green" is not "issue solved".** The repo's post-merge rules were
  both artifact-level: the manager verifies the post-merge `Staging` workflow is
  green for the merge commit, and `ship`'s completion criterion names staging
  deploy, Golden Set smoke, ZAP, Schemathesis, E2E, and the restore drill. None
  of them answers the issue's own question.
- **The smoke's coverage is five questions plus three host checks.** The
  `Staging` smoke is a stratified, deterministic subset of `golden-set-v0`
  (`gs-v0-019`, `gs-v0-020`, `gs-v0-015`, `gs-v0-001`, `gs-v0-002`), and the
  deploy's own smoke checks health, an anonymous mint, and the SPA HTML. A
  runtime change to a different code path — retrieval, assembly, prompts,
  citations, a route, the web UI — leaves staging green while the issue may be
  entirely unfixed. This is not hypothetical: #241 was closed by hand on
  `gs-v0-015` staging evidence, and #251 carried a hand-written closure gate in
  its PR body for `gs-v0-019` because the merge deliberately did not
  auto-close #250.
- **Improvised evidence dies with the session.** Both precedents were manager
  discipline, not process: nothing in the repo would have caught their absence,
  and nothing required either one.
- **Production is weaker still.** Promotion is an owner-gated dispatch — that
  approval is the recorded sign-off — and prod smoke is the same host-level
  trio. No behavioural verification of a specific issue exists in prod
  anywhere.
- **The owner's direction** is a dedicated adversarial tester: not only the
  issue itself, but creative probing of the surrounding behaviour, happy and
  non-happy paths, and the persona of a user who abuses or hacks the system —
  with the manager deciding whether a change needs that phase.

## Decision

### 1. The manager classifies every change, and records the decision either way

The QA phase is **manager-gated**. Every change is classified against three
shapes before merge, and the manager records the decision in its final summary
whether or not a QA phase follows — a `QA phase: not needed because …` line
counts as the record, the same "record the judgment" pattern the
fix-then-re-review trigger already uses:

| Change                                                                   | Shape              | What verifies it                                                    |
| ------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------- |
| Tests-only, scripts, docs, skills, agent files, CI metadata              | **Inert**          | Nothing — no QA phase; the record names why.                        |
| Eval scorers, fixtures, smoke selection                                  | **Gate-affecting** | **Falsification** — the gate must still fail on an injected defect. |
| Routes, chat pipeline, prompts, retrieval, contracts, migrations, web UI | **Runtime**        | **Full staging QA**, adversarial persona included.                  |

The **manager-decides boundary** is exactly this: the shape, the ticket, the
observable, and the environment. No orchestrator, role agent, or CI job
decides that a change skips QA.

### 2. A QA-needed change gets a QA ticket, and the manager confirms the observable is reachable before promising it

The ticket is the brief (contract owned by `.agents/skills/qa-phase/SKILL.md`):
the observable that proves the issue is solved in staging; the blast radius;
the surfaces to probe; the abuse angles for that change; the environment with
the merge SHA and the `Staging` run id; and the spend cap.

**Reachability is confirmed before the observable is promised**: the manager
reads what `selectSmokeSubset` actually selects and confirms the merge triggers
a `Staging` run at all (a docs-path-only push does not). When the observable
sits outside the subset, the manager widens that run through the existing
`workflow_dispatch` inputs (`eval_smoke_size`, `eval_budget_micro_usd`) or puts
a targeted probe in the ticket. A promise the deployed run cannot reach is a
blocker, not a QA ticket.

### 3. Gate-affecting changes are verified by falsification, not by probing users

A change to an eval scorer, a fixture, or the smoke selection ships no
user-visible behaviour to probe, and a healthy staging answer says nothing
about whether the gate can still go red. Its QA ticket's observable is a
**mutation**: inject the defect the gate must catch, show `passed: false`, and
show the good case still passes. Staging smoke evidence is not falsification
evidence.

### 4. Runtime changes get the full staging QA, adversarial persona included

The probe taxonomy is **required, not optional**: the issue's acceptance
criterion reproduced in staging; neighbouring behaviour on the changed code
path; happy, non-happy, and boundary inputs; and the adversarial persona — at
minimum prompt injection through the query or the retrieved corpus, forcing a
fabricated citation past the validator and the citations frame, the
trap/refusal boundary and the dhaif-grade warning, madzhab-policy bypass,
session/token abuse (another session's id, replayed tokens, cross-session
traces or feedback), erasure-path abuse (`DELETE /v1/auth/me`) against the
retention claims, cost/rate abuse (ADR-0041), and malformed SSE/frame tampering
with hostile-content rendering. A class that does not apply is named in the
ticket with its reason.

### 5. A new dedicated role runs the phase — read-only, staging-only, verdict-bound

`.zcode/agents/qa.md` defines the QA agent: it works against the **deployed
staging environment** rather than a worktree, it is **read-only on the repo**
(comments and finding tickets yes; commits, branches, merges, and closures
no), it uses **anonymous sessions only and erases every session it creates**,
it takes no destructive action against the corpus or the store, and it stays
inside the ticket's cap. It does not fix code: **every real defect becomes its
own ticket**. The role's model pin is a high-reasoning model, because
adversarial scenario design is the whole job.

### 6. The verdict is the completion gate — and cleanup sits behind it

The QA agent posts a verdict — **`verified` / `not verified` / `blocked`** — on
the QA ticket, with per-probe evidence, the spend against the cap, and the ids
of everything it produced. A QA-needed change **is not finished until its
verdict is recorded**: manager step 7 verifies it one-shot, `not verified` and
`blocked` are relayed to the user verbatim with their defect tickets sent
through the normal implement → review loop, and the worktree-cleanup duty moves
behind that check as well as the post-merge CI check. `ship`'s completion
criterion carries the same requirement for QA-needed releases. **"The workflow
is green" is not a verdict.**

### 7. Cost is bounded per ticket

A gate-affecting QA phase costs nothing — falsification runs against recorded
evidence and committed scorers, no LLM call. A runtime QA phase costs a handful
of answers at the product's per-query price (SPECS §5: ~$2–3 per 1K queries),
so a five-probe run lands under a cent; the ticket's cap defaults to the smoke
job's **$1 per run** (ADR-0034) and may be set lower, never higher without the
owner. The actual spend is reported against the cap on every verdict.

### 8. Scope: staging only

The QA phase verifies **staging**. Production keeps its owner-gated dispatch
and its host-level smoke; a behavioural prod check is deliberately not added
here (see the revisit trigger below).

## Rationale

- **It closes the gap between the artifact and the issue.** The smoke is a
  regression gate on five questions; the QA phase verifies _this_ change's
  observable and its blast radius. The two are complementary: the smoke is the
  scheduled floor, the QA verdict is the issue-level evidence.
- **The manager-decides boundary keeps it proportionate.** A docs-only change
  pays nothing; a runtime change pays cents. The classification table is the
  boundary, and recording the decision either way makes a skipped QA phase an
  auditable judgement instead of an omission.
- **Falsification is the only evidence a gate change can produce.** Probing
  staging user behaviour for a scorer change measures the generator, not the
  gate; mutation measures the gate.
- **A read-only role cannot launder a failure.** An agent that could commit
  could "fix" the environment it is judging; an agent that can only report must
  leave the evidence where it found it.
- **The evidence becomes durable.** Ticket, verdict, spend, and defect tickets
  outlive the session that produced them — which is what the two improvised
  precedents could not do.

## Alternatives considered

- **Keep the two artifact-level rules (status quo).** Rejected: a green
  `Staging` run proves the deploy took; it does not prove the issue is fixed,
  and the two closures that did verify behaviour were hand-run and
  unrepeatable.
- **QA on every change, no classification.** Rejected: docs, tests, skills, and
  CI metadata cannot alter deployed behaviour, so the phase would spend money
  and time to prove nothing — and a gate-affecting change would still be
  unverifiable by user-behaviour probing.
- **A pre-merge QA gate in CI.** Rejected: PR-time smoke against PR code is not
  possible without deploying a preview, which is why the deploy-then-smoke
  pairing is the gate (SPECS §3.7). The QA phase is therefore post-merge, and a
  `not verified` verdict does not block the merge — it opens defect tickets and
  keeps the change unfinished.
- **Probing gate-affecting changes against staging user behaviour.** Rejected
  in favour of falsification (decision 3): it would test the generator and call
  it the gate.
- **Behavioural verification in production on every release.** Rejected for
  now: prod has no rollback runway beyond `git revert`, the owner-gated
  dispatch is the recorded sign-off, and staging and production share the box —
  so a prod probe would spend and risk more without measuring a different
  artifact. Recorded as the revisit trigger below.
- **An ad-hoc checklist in the manager's head.** Rejected: that is exactly the
  precedent (#241, #250) this ADR replaces, and it dies with the session.

## Consequences

- **The manager's post-merge duty grows** from one CI check to: classify,
  record the decision, confirm the observable's reachability, write the QA
  ticket, dispatch the `qa` role, and verify the verdict — with cleanup behind
  all of it. The rule is stated once, in manager step 7, and referenced from
  step 6's summary and the anti-pattern list.
- **A new role, a new skill, and a new dispatch surface.** `qa` joins the DSH
  dispatch role set and the ZCode adapter's role list; the pin is verified by
  `bun run dsh:preflight` like every other role's.
- **The QA phase's own evidence is only as good as its ticket.** A badly
  specified observable produces a `blocked` or a misleading `verified`; the
  manager owns the observable, and the QA agent's `blocked` verdict is the
  signal to re-specify rather than to force a probe set.
- **Staging spends money on probes.** Bounded by the ticket's cap and reported
  per verdict; the smoke job's $1 cap is the default so no QA run can outspend
  a smoke without a deliberate owner decision.
- **A `not verified` verdict leaves a merged, green PR unfinished.** That is the
  intended shape: the fix travels as its own ticket through implement → review →
  merge, and the QA verdict is re-issued for the new merge if the observable is
  still in question.
- **The runtime prompt/posture is untouched.** This ADR adds verification, not
  behaviour: no pipeline stage, no contract, no prompt, no route changes.

## Revisit triggers

- **A defect escapes staging QA into production** (or a public user base makes
  staging-only verification insufficient) → add the prod variant: the same role
  and the same ticket contract pointed at the production URL, behind the
  existing owner-gated dispatch, recorded as an amendment to this ADR.
- **The QA role's adversarial design proves too weak** — a defect survives a
  `verified` verdict → re-head the role's model pin or extend the probe
  taxonomy, and record which probe class failed to catch it.
- **The $1 cap blocks a legitimate run** → raise it per ticket with the owner's
  approval, or split the ticket by surface; never silently exceed it.
- **A second harness or a standalone DARS repo consumes the phase** → the skill
  stays harness-agnostic and the role's pin stays in `.zcode/agents/`; only the
  adapter's spawn mechanics change.

## Implementation map

| Surface                                                                      | Change                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.zcode/agents/qa.md`                                                        | The role: read-only, staging-only, verdict-bound, no worktree                                                                                                                                                                     |
| `.agents/skills/qa-phase/SKILL.md`                                           | The shape table, ticket contract, probe taxonomy, falsification rule, report contract, safety rails                                                                                                                               |
| `.agents/skills/manager/SKILL.md`                                            | Roles table gains D; step 6 records the classification; step 7 carries the QA-phase decision, reachability check, dispatch, verdict check, and cleanup behind it; workspace-isolation and todo-duty bullets name the QA exception |
| `.agents/skills/ship/SKILL.md`                                               | Completion criterion gains the QA verdict for QA-needed releases                                                                                                                                                                  |
| `.agents/skills/manager/ZCODE-ADAPTER.md`, `scripts/dsh-dispatch-prompt.mjs` | The `qa` role joins the dispatchable role set on both harnesses                                                                                                                                                                   |
| `scripts/dsh-pin-check.mjs`                                                  | No code change needed — it reads every `.zcode/agents/*.md` pin, so the new pin is checked automatically                                                                                                                          |
| `SPECS.md` §2.2, §3.7, §8                                                    | The control table row, the cadence sentence, this ADR's row                                                                                                                                                                       |
| Runtime (`apps/`, `packages/`, pipeline, contracts)                          | **no change**                                                                                                                                                                                                                     |
