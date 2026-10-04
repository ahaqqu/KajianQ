# ADR-0050: Scalability is an architecture principle — one box by default, never locked to one process

## Decision

Scalability becomes principle §18 of [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md): **one box by default, never
locked to one process**. The single instance stays the posture, and no code may assume it — adding instances is a
deployment change, not a rewrite.

The invariant is four clauses: every durable byte lives in a shared store, Postgres plus the `ObjectStore` seam, so
nothing a second instance must read is host-local disk or process memory; the request path is stateless, with no
in-process session store, queue, scheduler, or client affinity; a stream is request-scoped, its answer persisted
before the first byte, so a dropped stream is recoverable rather than lost with the process; and in-process state
carries a seam and a trigger naming the condition that retires it.

Two exceptions are sanctioned, and both belong to ADR-0044: the rate-limit counter, whose seam exists already, its
trigger a scale-out past one process, and the single-instance provisioning topology, its trigger a second deploy
target. A second **host** is a new record, not an edit — Postgres reachability (TLS and `pg_hba` entries, plus a
decision on the loopback-only posture), the restic repository's host locality, and the cron owner all change together.

## Why

The audit asked whether a second application server can be added safely, and the answer split: the application tier is
scale-out shaped already, three mechanisms outside it are not. The rate-limit counter is per process, so instances
enforce independent per-IP budgets and a deployment-global guarantee silently becomes a multiple. The provisioning
path cannot address a second instance — an untemplated unit, no port variable, a restart grant naming one unit
literally, no upstream pool, a one-host in-place deploy. And the connection ceiling is unpinned, so saturation queues
rather than failing fast. The one-process premise was written down three times — as rationale, as an architecture
bullet, as two revisit triggers — and enforced in none: correct and unprotected at once, surviving only as long as the
next author read all three. Naming it a principle makes "does this PR add per-instance state?" a review question, the
only gate available without new code. The invariant is cheap to hold now and expensive to restore later, since nothing
in it asks for work at one instance; recording the exceptions beats pretending they are absent; and not building
scale-out is the cost-disciplined answer, because the single instance stays the posture until a trigger fires.
Rejected: building multi-instance provisioning now, when nothing measured demands it; sticky routing as the first
move, which partitions the budget instead of restoring it; leaving scalability implicit, the state the audit found;
amending ADR-0044 instead of a new record, because the invariant covers the whole application tier; folding the
module-state scan into this change, recorded as a gap instead; and adding a connection ceiling or port variable while
here, both belonging with the scale-out work they serve.

## Consequences

A second instance requires a closed list, in order: a shared rate-limit counter behind the limiter seam; a pinned
connection budget, so saturation fails fast instead of queueing; instance-addressable serving — a templated unit with
its own port, an upstream pool, and a restart grant covering every instance; a single cron owner for a multi-host
fleet, which is cleanliness rather than correctness because the work is idempotent; and a readiness probe that touches
the store before any load balancer goes in front. The rolling path has a companion gap worth stating: a request that
reached a draining instance fails as a 502 even though its answer is already persisted, and the web client drops the
optimistic turn and shows an error instead of re-reading the transcript — a gap that exists at one instance and only
gets more frequent with a fleet. The invariant has named checks: the `AGENTS.md` guardrail binds every task, the
plan-review checklist asks it of a plan, and the code-review bullet asks it of a PR, so per-process state is
questioned at every layer. The single-instance posture stops being an accident: it is a decision with two sanctioned
exceptions and a written list of what retires them. The known gaps are visible rather than implied — no readiness
probe, no instance identity in a log line, no lock in the migration runner, and no leader election for the reclamation
timer. Nothing changes at one instance: no code, configuration or runtime behaviour is touched. The principle can be
falsified — the first PR adding module-level mutable state to serving code without a seam, or the first second
instance stood up with the list open, is evidence this record was wrong. The recorded triggers: a PR adding
module-level mutable state to serving code without a seam means the automated scan is due, because the review duty
alone has failed; measured load approaching one instance's ceiling means capacity work, with vertical sizing measured
first before any fleet is stood up; and `GET /v1/health` gaining a consumer means the store-touching readiness probe
lands with it, because a static health body is not a readiness signal.
