# ADR-0064: The operator's trace browser is a credential-gated, read-only surface with an append-only access log

## Decision

The deployment may expose a trace browser to its own operator, and only to them. It
answers under the existing API prefix — not a namespace of its own — with its own
session cookie and no other credential, and it is excluded from the public API
description. It is off until the deployment configures a credential; until then every
path on it answers exactly what a wrong credential answers — "not enabled" is "not you".

The session is a signed token with a short lifetime and a random session id. Signing out
revokes that id in a server-side denylist before it clears the browser's cookies, so the
token stops working on every instance serving the surface, and a copied cookie is dead
from then on; every other live session keeps working. An expired, forged, malformed or
revoked token is the same refusal, and a failed revocation is a failed sign-out.

It is read-only: it lists answers by the stored question and answer text, date, routed
intent, models, refusal, relaxed retrieval, and per-answer latency and cost floors, over
server-side pagination with a stable link per answer. The detail is the chat panel's own
derivation over the persisted trace, plus the stored trace download and the answer's
totals over every provider call it made.

Every read is recorded before it is served, in an append-only log of when, which route,
and a summary of the filters' dimensions — never the question, the answer or the search
text — and a read whose record cannot be written is not served. The log has a retention
window the nightly cleanup enforces and the store refuses to rewrite or delete inside.
The revocation rows hold only a random id and the token's expiry, pruned by that step.

## Why

The support question this answers is "this answer was wrong — why". Nothing in the public
surface can answer it: the trace exists, but only its caller can see it, and an operator
investigating a report does not hold that session; logs cannot reconstruct it.

The obvious shortcut — a shared header token, or the public session — was refused. A token
in a URL or header leaks into browser history, proxies and screenshots, and the public
session is the caller's own — reading on their behalf without their act. A separate
credential and cookie keep the identities disjoint, and scoping it to the admin namespace
keeps it off public routes; sharing the API prefix keeps enabling it a code change.

A sign-out that only clears the browser's copy does not end the credential: a stolen or
copied cookie keeps read access for its lifetime. The denylist is the smallest server-side
state that closes that gap: an opaque session table would replace the stateless signature
check with a per-request identity store, while a revocation list keeps verification
stateless, stays correct across instances, and expires with the token it revokes.

The access log is the counterweight to that power. Reading chat content is a personal-data
access, and the obligation is to say who read what and when, which cannot be reconstructed
afterwards. Logging dimensions rather than text is what makes the log safe to keep: it
records that a search happened without recording what was searched for, so it never becomes
a second copy of the content it audits; failing closed keeps the record without holes.

## Consequences

- The credential and the log's window are deployment configuration; a session's lifetime
  is code, and an unset credential disables the surface without blocking boot.
- Operator access to personal data joins the RoPA; the log's retention joins the
  published values, and the revocation rows live no longer than the tokens they end.
- The surface is excluded from the public API description, the public shell carries no
  link to it, and the detail and chat panel share one derivation.
