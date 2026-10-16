# ADR-0040: The server derives the citation payload from the persisted trace; the client renders the frame

## Decision

**The server derives the structured citation payload from the persisted answer trace; the client never parses answer text for citations.** The chat route emits one citations frame carrying the citations, the refusal flag and the dhaif warning. The derivation is an intersection: the emitted citations are exactly the answer's inline citation spans, located with the citation gate's own grammar and normalization, that a chunk referenced by the trace's retrieval event grounds — a span matching no trace chunk cannot appear. Display data joins by the trace's chunk ids through one store read, and the refusal flag is the trace's own refusal decision, projected independently of the list so that a hybrid answer running into the canonical refusal sentence keeps its chips.

**The client renders the frame, never the grammar.** Citation chips are located in the answer text by exact match of frame labels only: a label absent from the text renders nothing, and a bracketed span absent from the frame stays plain text.

**Reload is full rehydration, and streaming stays interface-scoped.** The session id and token persist client-side as anonymous-session state (ADR-0017), erasure staying server-side, and on load the interface restores the transcript from the rehydration endpoint, which derives each assistant message's payload from its own persisted trace — the same derivation as the live frame, so a past answer can never show a citation its trace does not ground. Each frame degrades independently: a failed derivation loses the frame and never invents one.

## Why

Citations, the warning and the disclaimer existed only as inline text, so a citation interface would have had to parse the answer text — re-implementing the citation grammar client-side. The product's stated first risk is fabricated religious content, and the deterministic citation gate already refuses answers citing anything outside the retrieved chunks; a client-side parser silently re-opens that hole, because any parsing drift turns a fabricated span into a chip and the failure is invisible — a confident interface over an unverified citation.

The data a citation interface needs is already persisted per answer: which chunks were retrieved, and which citation labels the answer grounded. User-visible data structures come from persisted trace records rather than ad-hoc reconstruction, which is what makes the trace, not the response text, the source of truth.

Rejected: a client-side grammar that chip-ifies bracketed spans, which re-implements the gate in a second language with no shared tests; resolving a citation's passage data on tap, which makes the affordance depend on a per-tap endpoint and still needs a client-side decision of which spans are citations; persisting the payload on the message at answer time, which duplicates a derivable structure and creates a second source of truth that can drift from the trace; extending the trace's chunk references to carry display text, which would duplicate corpus text into every trace row for data one store read away.

## Consequences

- New shared contracts carry the citation, the citations frame and the session transcript, and new store reads serve the chunk join and the trace by id; the derivation is an interface-layer concern over persisted data, so the engine's runner, stages and refusal gate are untouched.
- A chunk row deleted after an answer was persisted simply loses its chip, and a lost or unreadable trace degrades to a plain-text transcript, never to invented citations.
- The rehydration transcript is capped and says so: a session is an anonymous conversation, not an archive, and a truncation flag tells the client it is seeing the newest tail.
- The trace frame discloses the model identities that ran, deliberately — the panel is the never-hide-the-machinery instrument — while a friendlier display label would be a config-layer change.
- The trust-sensitive invariant is the intersection itself: the emitted citation set stays exactly the cited-and-grounded set.
