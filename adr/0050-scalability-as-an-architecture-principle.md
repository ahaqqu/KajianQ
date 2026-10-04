# ADR-0050: Scalability is an architecture principle — one box by default, never locked to one process

## Decision

Scalability becomes principle §18 of [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md): **one box by default, never
locked to one process**. The single instance stays the posture, on cost discipline, and no code may assume it — adding
instances is a deployment change, not a rewrite.

The invariant is four clauses: every durable byte lives in a shared store, Postgres plus the `ObjectStore` seam, so
nothing a second instance must read is host-local disk or process memory; the request path is stateless, with no
in-process session store, queue, scheduler, or client affinity; a stream is request-scoped, its answer persisted
before the first byte, so a dropped stream is recoverable rather than lost with the process; and in-process state
carries a seam and a trigger naming the condition that retires it.

Two exceptions are sanctioned, and both belong to ADR-0044: the rate-limit counter, whose seam exists already and
whose trigger is a scale-out past one process, and the single-instance provisioning topology, whose trigger is a
second deploy target. A second **host** is a new record, not an edit.

## Why

The audit asked whether a second application server can be added safely, and the answer split: the application tier is
already scale-out shaped, while three mechanisms outside it are not. The rate-limit counter is per process, so
instances enforce independent per-IP budgets and a deployment-global guarantee silently becomes a multiple. The
provisioning path cannot address a second instance — an untemplated unit, no port variable, a restart grant naming one
unit literally, no upstream pool, a deploy that is one host and an in-place restart. And the connection ceiling is
unpinned, so saturation queues rather than failing fast. The one-process premise was already written down three times
— as rationale, as an architecture bullet, and as two revisit triggers — and enforced in none, so it was correct and
unprotected at once, surviving only as long as the next author read all three places. Naming it a principle makes
"does this PR add per-instance state?" a review question, the only gate available without new code. The invariant is
cheap to hold now and expensive to restore later, since nothing in it asks for work at one instance; recording the
exceptions beats pretending they are absent; and not building scale-out is the cost-disciplined answer. Rejected:
building multi-instance provisioning now, when nothing measured demands it; sticky routing as the first move, which
partitions the budget instead of restoring it; leaving scalability implicit, which is the state the audit found;
amending ADR-0044 instead of a new record, because the invariant covers the whole application tier; folding the
module-state scan into this change, recorded as a gap instead; and adding a connection ceiling or a port variable
while here, both belonging with the scale-out work they serve.

## Consequences

A second instance requires a closed list, in order: a shared rate-limit counter behind the limiter seam; a pinned
connection budget, so saturation fails fast instead of queueing; instance-addressable serving — a templated unit with
its own port, an upstream pool, and a restart grant covering every instance; a single cron owner for a multi-host
fleet, which is cleanliness rather than correctness because the work is idempotent; and a readiness probe that touches
the store before any load balancer goes in front. The invariant has named checks: the `AGENTS.md` guardrail binds
every task, the plan-review checklist asks it of a plan, and the code-review bullet asks it of a PR, so per-process
state is questioned at every layer. The single-instance posture stops being an accident: it is a decision with two
sanctioned exceptions and a written list of what retires them. The known gaps are visible rather than implied — no
readiness probe, no instance identity in a log line, no lock in the migration runner, and no leader election for the
reclamation timer. An automated scan that fails a PR for adding module-level mutable state to serving code is a
follow-up change, recorded as a gap rather than implied. Nothing changes at one instance: no code, configuration, or
runtime behaviour is touched. The principle can be falsified — the first PR adding module-level mutable state to
serving code without a seam, or the first second instance stood up with the list open, is evidence this record was
wrong.
