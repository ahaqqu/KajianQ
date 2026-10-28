# ADR-0064: The operator's trace browser is a credential-gated, read-only surface with an append-only access log

## Decision

The deployment may expose a trace browser to its own operator, and only to them.
It answers under the existing API prefix — not a namespace of its own — with its
own session cookie and no other credential, and it is excluded from the public API
description. Shipping it is a code change: the proxy already serving the API
carries it, so no host configuration or privileged reload is needed.

It is off until the deployment configures a credential; until then every path on
it answers exactly what a wrong credential answers — the same refusal, with
nothing distinguishing "not enabled" from "not you".

It is read-only. It lists answers by the stored question and answer text, a date
range, the routed intent, the models that served the run, refusal, relaxed
retrieval, and per-answer latency and cost floors, over server-side pagination with
a stable link per answer. The detail is the chat panel's own derivation over the
persisted trace, plus the stored trace download and the answer's totals over every
provider call it made.

Every read is recorded before it is served, in an append-only log of when, which
route, and a summary of the filters' dimensions. The log carries no question, no
answer and no search text, and a read whose record cannot be written is not
served. The log has a retention window enforced by the nightly cleanup, and the
store refuses to rewrite or delete a record the window still holds.

## Why

The support question this answers is "this answer was wrong — why". Nothing in the
public surface can answer it: the trace exists, but only the caller who owns the
message can see it, and an operator investigating a report does not hold the
reporter's session; logs cannot reconstruct it, since the machinery is on the trace.

The obvious shortcut — a shared header token, or the public session — was refused.
A token in a URL or header leaks into browser history, proxies and screenshots,
and the public session is the caller's own — reading on their behalf without their
act. A separate credential and cookie keep the identities disjoint, and scoping
that cookie to the admin namespace keeps it off public routes.

Sharing the API prefix instead of claiming a top-level one makes the surface
deployable without root: a top-level path is absent from a host whose proxy predates
it — closed, but indistinguishable from missing — and fixing that needs root.

The access log is the counterweight to that power. Reading chat content is a
personal-data access, and the obligation is to say who read what and when, which
cannot be reconstructed afterwards. Logging dimensions rather than text is what
makes the log safe to keep: it records that a search happened without recording
what was searched for, so it never becomes a second copy of the content it audits.
Failing closed is deliberate — the log is only evidence if it cannot have a hole
where a read happened.

## Consequences

- The credential, the session lifetime and the log's window are deployment
  configuration; an unset credential disables the surface without blocking boot.
- Operator access to personal data joins the RoPA, and the log's retention joins
  the published retention values.
- The surface is excluded from the public API description, the public shell carries
  no link to it, and the detail and chat panel share one derivation.
