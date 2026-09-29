# ADR-0050: Scalability is an architecture principle — one box by default, never locked to one process

## Status

Accepted (2026-09-29). Owner-directed — "i want scalability is part of
architecture principle" — after an in-session scale-out audit that asked whether
a second API instance can be added safely. **Docs-only**: this ADR adopts
principle §18 of [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) and records
the scale-out posture, the two sanctioned single-instance exceptions, and what a
second instance requires. It builds nothing. It does not relitigate ADR-0044
(the Bun process behind nginx, the rate limiter's process-wide guarantee),
ADR-0043 (netcup VPS hosting, EU residency), or ADR-0008 (the `RagStore` seam);
ADR-0044's revisit triggers stay the operative record for the exceptions named
in decision 3.

**Numbered 0050, not 0049.** 0049 is claimed by a parallel in-flight ADR —
retrieved-verse neighbourhood expansion and range grounding (PR #291) — which
was authored first and had already cited the number across roughly twenty code
and doc references and in issue #300's text. Renumbering that unmerged branch
would have rewritten all of them to correct a number this record took by reading
only `main`'s highest file; renumbering this merged record instead touches four
references in three files and leaves the other side's citations correct. The
sequence therefore reads 0048 → 0050 on `main` until PR #291 lands its 0049.

## Context

The audit asked one narrow question — _can a second application server be added
without breaking anything?_ — and the answer split cleanly: the application tier
is already scale-out shaped, while three mechanisms outside it are not.

**Already scale-out shaped — verified in the tree, no runtime test needed to
state it:**

- **Every durable byte lives in a shared store.** Users and sessions, chat,
  traces, feedback, the eval ledger, and the corpus are Postgres rows behind the
  `RagStore` adapter; blobs live behind the `ObjectStore` seam. Auth is a read
  (`SELECT … WHERE token_hash = … AND expires_at > now()`,
  `packages/infra/src/rag-store-postgres-session.ts`), the browser holds the
  session id, and no request needs affinity: any instance can serve any turn of
  any conversation.
- **An answer is durable before it is streamed.** `POST /v1/chat` persists the
  trace and the assistant message _before_ the first SSE byte
  (`apps/api/src/routes/chat.ts`), and the stream is request-scoped — no
  server-side registry, buffer, or resume protocol. A lost stream costs the live
  turn, never the persisted answer.
- **There is no per-process scheduled work to duplicate.** The reclamation is a
  systemd timer running a separate oneshot entry, not an in-process interval,
  and its two DELETEs are naturally idempotent
  (`provision/vps/systemd/kajianq-cron.timer`,
  `packages/infra/src/rag-store-postgres-session.ts`). The only in-process
  timers are a shutdown deadline and outbound fetch timeouts. No local
  filesystem writes, no PID files, no advisory locks, no `LISTEN`/`NOTIFY`, no
  in-process sequences.
- **Concurrent writers do not corrupt.** Primary keys are
  `uuid DEFAULT gen_random_uuid()`, ingestion and feedback write through
  `ON CONFLICT` upserts on real unique keys, and `createSession` writes the user
  and its session in one transaction.

**What breaks or degrades with a second instance:**

1. **The rate-limit counter is per process.** `resolveRateLimiter()` returns one
   module-level in-memory `Map` (`packages/rate/src/resolve-rate-limiter.ts`),
   so N instances enforce N independent 120/min per-IP budgets and the
   deployment-global guarantee silently becomes ~N×120. ADR-0044 already records
   this as its own revisit trigger.
2. **The provisioning path cannot address a second instance.** The systemd unit
   is not templated and `PORT` is absent from `provision/vps/api.env.example`;
   the deploy identity's entire root grant names `kajianq-api.service` literally
   (`provision/vps/sudoers/kajianq-deploy`, pinned by
   `tests/scripts/vps-hardening.test.mjs`); nginx has no `upstream` block
   (`provision/vps/nginx/kajianq.conf`); the deploy is one host, an in-place
   rsync, and a `systemctl restart` (`provision/vps/deploy/deploy.sh`).
3. **The connection ceiling is unpinned.** Each API process opens a pool of
   `max: 10` (`packages/infra/src/rag-store-postgres-driver.ts`) while
   `max_connections` appears nowhere in the repo, so the ceiling is the distro
   default — steady state `10N + 2`, and the pool sets no
   `connectionTimeoutMillis`, so saturation queues instead of failing fast.

**Named alongside them, in the order they would bite:** no readiness probe
(`GET /v1/health` returns a static body and never touches the store, so a load
balancer would happily register an instance that cannot reach Postgres); no
instance identity in a log line; no lock in the migration runner, whose per-file
transaction also rules out `CREATE INDEX CONCURRENTLY`; and no leader election
for the reclamation timer if a second **host** ever appears. A second host is
otherwise its own decision: Postgres listens on loopback only, and
`provision/vps/postgres/99-kajianq.conf` already says a second host needs TLS and
`pg_hba` entries as a new decision.

**Why this needs a decision and not just a paragraph.** The one-process premise
is already written down three times — as rationale (ADR-0044), as an
architecture bullet (§8's rate-limiting paragraph), and as two revisit triggers
— but scalability itself is not a principle, so no PR review asks whether a
change quietly added per-instance state. The premise is therefore correct and
unprotected at the same time: it survives only as long as the next author reads
all three places.

## Decision

### 1. Scalability becomes principle §18 of `docs/ARCHITECTURE.md`

The principle is **"one box by default, never locked to one process"**: the
single instance stays the posture (cost discipline, ADR-0043/ADR-0044), and no
code may assume it. Adding instances is a deployment change, not a rewrite.

### 2. The invariant is four clauses

1. **Every durable byte lives in a shared store.** Postgres is the single
   durable copy; blobs go behind the `ObjectStore` seam. Nothing a second
   instance must read is written to a host-local disk or held in process memory.
2. **The request path is stateless.** No in-process session store, queue,
   scheduler, or client affinity. Any instance may serve any request, including
   a follow-up turn started elsewhere.
3. **A stream is request-scoped.** An answer's text and trace are persisted
   before the first SSE byte, so a dropped stream is recoverable from the store
   rather than lost with the process that produced it.
4. **In-process state carries a seam and a trigger.** Where a per-process
   mechanism exists deliberately, it sits behind a single indirection point and
   names the condition that retires it.

### 3. Two exceptions are sanctioned today, and both belong to ADR-0044

- **The rate-limit counter** (`resolveRateLimiter()`): the seam already exists;
  the trigger is a scale-out to more than one process, which requires a shared
  counter (store-backed limiter or sticky routing).
- **The single-instance provisioning topology** (unit, deploy host, sudoers
  grant, nginx upstream): the trigger is a second deploy target.

This ADR sanctions the exceptions as _decisions with triggers_; it does not
pretend the in-memory backend scales, and it does not build the counter.

### 4. A second instance requires this list closed, in order

1. A shared rate-limit counter behind `resolveRateLimiter()`.
2. A pinned connection budget: set `max_connections` in
   `provision/vps/postgres/99-kajianq.conf` (and/or lower the per-instance pool),
   and add `connectionTimeoutMillis` + `statement_timeout` so saturation fails
   fast instead of queueing.
3. Instance-addressable serving: a templated unit with its own `PORT`, an nginx
   `upstream` pool, a restart grant that covers every instance (or a root-owned
   installer), and a rolling path.
4. A single cron owner for a multi-host fleet: enable the timer on exactly one
   host, or serialize the runs with an advisory lock — the work is idempotent,
   so this is cleanliness, not correctness.
5. A readiness probe that touches the store, before any load balancer is put in
   front.

The rolling path in (3) has a companion gap worth stating: a request that
reached a draining instance fails as a 502 even though its answer is already
persisted, and the web client currently drops the optimistic turn and shows an
error instead of re-reading the transcript. That gap exists at N=1; a fleet
just makes it more frequent.

### 5. A second host is a new ADR, not an edit

Postgres reachability (TLS + `pg_hba` + a decision on the loopback-only
posture), the restic repository's host locality, and the cron owner all change
together; they are recorded here as one future decision rather than three silent
edits.

### 6. The gate is review today, and the automated one is an open gap

What exists now: the `AGENTS.md` guardrail bullet (so the rule binds every task),
the Scalable entry in `.agents/skills/plan-review/SKILL.md` (so a plan is checked
before code), the Scalable bullet and corrected principle range in
`.agents/skills/code-review/SKILL.md` (so a PR is checked before merge), and the
recorded triggers in this ADR and ADR-0044. What does **not** exist: an automated
scan that fails a PR for adding module-level mutable state to serving code. This
ADR records that gap deliberately instead of implying a gate that is not there;
the scan is a follow-up change, not part of this docs-only decision.

### 7. What this does not claim

It is not a capacity promise, not a commitment to run N instances, and not a
licence to add in-process state behind a comment. It is the invariant a reviewer
checks and the list a future scale-out closes — the posture stays one box until
one of the revisit triggers fires.

## Rationale

- **A principle changes review behaviour; prose does not.** The audit found the
  one-process premise stated in three places and enforced in none. Naming it §18
  makes "does this PR add per-instance state?" a review question, which is the
  only gate available without new code.
- **The invariant is cheap to hold now and expensive to restore later.** Nothing
  in it asks for work at N=1: sessions are already DB rows, answers are already
  persisted before streaming, and the reclamation is already a separate process.
  What it protects is the property those choices bought — that scale-out stays a
  deployment change.
- **Recording the exceptions beats pretending they are absent.** The rate
  limiter and the provisioning topology are correct at N=1 and already carry
  ADR-0044 triggers. Listing them as sanctioned exceptions keeps the principle
  honest: scale-out is a closed list of known work, not a discovery exercise.
- **The gaps are named where they were found.** A readiness probe, an instance
  id in logs, a migration lock, and a connection budget are each small and each
  invisible until an operator is debugging a fleet. Naming them here is what
  lets them become tickets instead of surprises.
- **Not building scale-out is the cost-disciplined answer.** There is no
  measured load demanding a second instance, and the box's own numbers are not
  collected yet. The two enablers that pay off even at N=1 (the limiter seam, a
  readiness probe) can land when the trigger fires or when someone needs them.

## Alternatives considered

- **Build multi-instance provisioning now.** Rejected: nothing measured demands
  it, ADR-0044 already routes a second deploy target to its own decision, and
  the work is a closed list that keeps (decision 4) rather than an urgent gap.
- **Sticky routing instead of a shared counter.** Rejected as the first move:
  it partitions the budget rather than restoring it, and it adds affinity the
  client does not need — the client holds no server-side stream state. ADR-0044
  names it as the alternative for the same trigger.
- **Leave scalability implicit.** Rejected: that is the current state, and the
  audit's finding is precisely that the premise is stated but unchecked. A
  principle plus a review duty is the smallest change that makes it checkable.
- **Amend ADR-0044 instead of a new ADR.** Rejected: the invariant covers the
  whole application tier, not just the serving path, and a §8 row for a new ADR
  is what the spec's Record of Decisions expects. ADR-0044's triggers stay the
  operative record for the two exceptions.
- **Fold the automated module-state scan into this PR.** Rejected by scope: the
  owner asked for the principle and the decision record. The scan is recorded as
  an open gap (decision 6) so the omission is visible rather than implied.
- **Add a `max_connections` value and a `PORT` variable while here.** Rejected
  for the same reason: both are host-config changes that belong with the
  scale-out work they serve, not with a docs-only decision.

## Consequences

- **The invariant now has named checks.** `AGENTS.md` carries the guardrail,
  `plan-review` asks it of a plan, and `code-review` asks it of a PR (with its
  principle range corrected to §1–§14 and §17–§18), so "did this add per-process
  state?" is asked before code, at review, and at merge.
- **The single-instance posture stops being an accident.** It is a decision with
  two sanctioned exceptions and a written list of what retires them.
- **The known gaps are visible.** Readiness, instance identity, migration lock,
  connection budget, and cron ownership are named in decision 4 (and its
  companion note) as work that exists whether or not anyone schedules it.
- **Nothing changes at N=1.** No code, no configuration, and no runtime
  behaviour is touched; the deploy path, the limiter, and the health route are
  unchanged.
- **The principle can be falsified.** The first PR that adds module-level mutable
  state to serving code without a seam, or the first second instance stood up
  without decision 4 closed, is evidence this ADR was wrong — that is what the
  revisit triggers below are for.

## Implementation map

- [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — the tagline gains
  "Scalable", the new §18 carries the invariant and its gate line, and the
  document map moves to §19.
- [`SPECS.md`](../SPECS.md) — §3's runtime topology states the one-box /
  never-locked-to-one-process posture, and §8 gains this ADR's row.
- [`.agents/skills/code-review/SKILL.md`](../.agents/skills/code-review/SKILL.md)
  — the principle range in the review entry point is corrected to §1–§14 and
  §17–§18, and the silent-failure list gains the Scalable bullet that makes §18
  a review question.
- [`AGENTS.md`](../AGENTS.md) — a **Scalable by design** guardrail bullet, so the
  invariant binds every task rather than only a review pass.
- [`.agents/skills/plan-review/SKILL.md`](../.agents/skills/plan-review/SKILL.md)
  — a Scalable entry in the evaluation checklist, so a plan that adds
  per-instance state is caught before implementation.
- This file — the audit's verdict, the two exceptions, and the ordered list a
  second instance closes.

## Revisit triggers

- **Any second API instance** → decision 4 must be closed first; items 1–3 are
  the blockers, 4–5 are the companions.
- **A second host** → decision 5: a new ADR covering Postgres reachability, the
  backup repository's locality, and the cron owner together.
- **A PR adds module-level mutable state to serving code** → the automated scan
  in decision 6 is due; the review duty alone has failed.
- **Measured load approaches one instance's ceiling** → capacity work, with
  vertical sizing measured first (the box's own numbers are not collected yet)
  before any fleet is stood up.
- **`GET /v1/health` gains a consumer** (a load balancer, an uptime service with
  alerting) → decision 4 item 5 lands with it, because a static health body is
  not a readiness signal.
