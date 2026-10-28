# ADR-0064: The operator's trace browser is a credential-gated, read-only surface with an append-only access log

## Decision

The deployment may expose a trace browser to its own operator, and only to them.
It answers under its own path with its own session cookie and no other credential,
it is off until the deployment configures a credential, and until then every path
on it answers exactly what a wrong credential answers: the same refusal, with
nothing that distinguishes "not enabled" from "not you".

It is read-only. It lists answers with the dimensions needed to find a failing
one — the stored question and answer text, a date range, the routed intent, the
models that served it, whether the run refused, whether retrieval relaxed a
filter, and per-answer floors on latency and cost — over server-side pagination,
and each answer opens at a stable link. The detail is the same derivation the chat
panel renders for that answer, fed the persisted trace, plus the stored trace as a
download and the answer's totals summed over every provider call it made.

Every read is recorded before it is served, in an append-only log of when, which
route, and a summary of the filters' dimensions. The log carries no question, no
answer and no search text, and a read whose record cannot be written is not
served. The log has a retention window, and the nightly cleanup enforces it; the
store itself refuses to rewrite or delete a record the window still holds.

## Why

The support question this answers is "this answer was wrong — why". Nothing in
the product's public surface can answer it: the trace exists, but only the caller
who owns the message can see it, and an operator investigating a report does not
hold the reporter's session. Reconstructing the failure from logs is guesswork
because the machinery is on the trace, not in the request log.

The obvious shortcut — a shared token in a header, or the public session — was
refused. A token in a URL or a header leaks into browser history, proxies and
screenshots, and the public session is the caller's own — reading on their behalf
without their act. A separate credential and a
separate cookie keep the two identities disjoint: a stolen caller's token opens no
trace, and an operator's browser carries no caller session.

The access log is the counterweight to that power. Reading chat content is a
personal-data access, and the obligation is to be able to say who read what and
when — which cannot be reconstructed afterwards. Logging the dimensions rather
than the text is what makes the log itself safe to keep: it records that a text
search happened without recording what was searched for, so the log never becomes
a second copy of the content it audits.

Failing closed on a log-write failure is deliberate. The log is only evidence if
it cannot have a hole where a read happened, so a read that cannot be recorded is
refused rather than served unrecorded.

## Consequences

- The credential, the session lifetime and the log's window are deployment
  configuration; an unset credential disables the surface and never blocks boot.
- Personal-data access by operators joins the RoPA, and the log's retention joins
  the published retention values.
- The surface is excluded from the public API description, so no public document
  advertises it, and the public shell carries no link to it.
- The derived detail and the chat panel share one derivation, so a rendering change
  reaches both.
