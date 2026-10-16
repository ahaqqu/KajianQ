# ADR-0050: Scalability is an architecture principle — one box by default, never locked to one process

## Decision

Scalability is stated as a principle of the architecture: **one box by default, never locked to one process**. The single instance stays the posture and no code may assume it — adding instances is a deployment change, not a rewrite. The invariant has four clauses:

1. Every durable byte lives in a shared store — Postgres through `RagStore`, blobs through `ObjectStore` — never host-local disk or process memory.
2. The request path is stateless: no in-process session store, queue, scheduler or client affinity.
3. A stream is request-scoped and its answer is persisted before the first byte, so a dropped stream is recoverable rather than lost with the process.
4. In-process state carries a seam and a recorded trigger naming the condition that retires it.

Two exceptions are sanctioned, both ADR-0044's: the rate-limit counter, whose seam exists already and whose trigger is a scale-out past one process, and the single-instance provisioning topology, whose trigger is a second deploy target. A second host is a new record, not an edit: store reachability, the backup repository's host locality and the reclamation timer's owner change together.

## Why

The question was whether a second application server can be added safely, and the answer split: the application tier is scale-out shaped, the mechanisms outside it are not. The one-process premise was written down in several places and enforced in none — correct and unprotected at once, surviving only while the next author reads all of them. Naming it a principle makes "does this change add per-instance state?" a review question, the only gate available without new code. The invariant is cheap to hold now and expensive to restore later, because nothing in it asks for work at one instance.

Rejected: building multi-instance provisioning before anything measured demands it; sticky routing as the first move, which partitions the budget instead of restoring it; editing ADR-0044 rather than writing a new record, because the invariant covers the whole application tier.

## Consequences

- A second instance requires a closed list, in order: a shared rate-limit counter; a pinned connection budget, so saturation fails fast instead of queueing; instance-addressable serving, with a templated unit, an upstream pool and a restart grant covering every instance; one reclamation owner for a multi-host fleet; and a readiness probe that touches the store before a load balancer goes in front.
- The invariant has named checks: the guardrail binds every task, the plan review asks it of a plan, and the code review asks it of a change, so per-process state is questioned at every layer.
- Known gaps are visible rather than implied: no readiness probe, no instance identity in a log line, no lock in the migration runner, and no leader election for the reclamation timer.
- **Revisit when** serving code gains module-level mutable state without a seam (the review duty alone has failed and an automated scan is due); measured load approaches one instance's ceiling (vertical sizing is measured first); or `GET /v1/health` gains a consumer (the store-touching readiness probe lands with it).
