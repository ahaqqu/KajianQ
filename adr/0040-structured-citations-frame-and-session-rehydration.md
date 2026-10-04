# ADR-0040: Structured citation payload and session rehydration — the trace is the source of truth

## Decision

**The server derives the structured citation payload from the persisted answer trace; the client never parses answer
text for citations.** The chat route emits one citations frame before the stream closes, carrying the citations, the
refusal flag, and the dhaif warning. The derivation is an intersection: the emitted citations are exactly the answer's
inline citation spans, located with the citation gate's own grammar and normalization, that a chunk referenced by the
trace's retrieval event grounds — a span matching no trace chunk cannot appear. Display data joins by the trace's
chunk ids through one store read, and a refused answer carries the refusal flag with an empty citation list. **The
client renders the frame, never the grammar.** Citation chips are located in the answer text by exact match of frame
labels only: a label absent from the text renders nothing, and a bracketed span absent from the frame stays plain
text. The warning card shows the answer's own warning line, peeled by the rule's stable marker prefix, and falls back
to the frame's flag when a rehydrated text lacks it; the ulama disclaimer renders as a distinct footer, peeled the
same way.

**Reload is full rehydration, and streaming stays UI-scoped.** The session id and token persist client-side as
anonymous-session state (ADR-0017), erasure staying server-side, and on load the UI restores the transcript from the
rehydration endpoint, which derives each assistant message's payload from its own persisted trace — the same
derivation as the live frame, so a past answer can never show a citation its trace does not ground. A rejected token
re-bootstraps and retries once, and a reclaimed session starts clean. The wire contract and its delta sequence are
otherwise unchanged, and it carries a trace frame derived from the same persisted trace — the rehydration payload
carrying that frame per assistant message — each frame degrading independently, so a failed derivation loses the frame
and never invents one.

## Why

Before this, citations, the dhaif warning, and the disclaimer existed only as inline text, so a citation UI would have
had to parse the answer text — re-implementing the citation grammar client-side. The product's stated first risk is
fabricated religious content, and the deterministic citation gate already refuses answers citing anything outside the
retrieved chunks; a client-side parser silently re-opens that hole, because any parsing drift turns a fabricated span
into a chip and the failure is invisible — a confident UI over an unverified citation. The data a citation UI needs is
already persisted per answer: which chunks were retrieved, and which citation labels the answer grounded. User-visible
data structures must come from persisted trace records rather than ad-hoc reconstruction, which is what makes the
trace, not the response text, the source of truth. Rejected: a client-side grammar that chip-ifies bracketed spans,
which re-implements the gate's grammar in a second language with no shared tests and fabricates citations silently on
drift; resolving a citation's passage data on tap, which keeps the payload small but makes the affordance depend on a
per-tap endpoint and still needs a client-side decision of which spans are citations; persisting the payload on the
chat message at answer time, which duplicates a derivable structure and creates a second source of truth that can
drift from the trace; and extending the trace's chunk references to carry display text, which would change the
engine's trace projection and duplicate corpus text into every trace row for data that lives one store read away.

## Consequences

New shared contracts carry the citation, the citations frame, and the session transcript — engine package, domain
values travelling as plain strings — and new store reads serve the chunk-children join and the answer trace by id. No
engine logic changed: the runner, the stages, and the refusal gate are untouched, and the eval harness ignores the new
frame, so ledger keying is unchanged. A new session is an explicit control and follow-ups ride the stored id. A chunk
row deleted after an answer was persisted simply loses its chip, the invariant by omission; a lost or unreadable trace
degrades to a plain-text transcript, never to invented citations. The rehydration transcript is capped: a session is
an anonymous conversation, not an archive. The cap is visible rather than silent — a truncated flag tells the client
it is seeing the newest tail and the UI says older messages are not shown. The translation-layer flag tracks the
layer's presence, matching the assembler's label, a coupling enforced by test rather than by data. A human-checked
translation layer in the corpus must not land by data mutation alone: it needs a per-chunk provenance field consumed
by the derivation before the flag's meaning may change. The trace frame discloses raw config-resolved model ids
deliberately — the panel is the never-hide-the-machinery instrument — while a friendlier config-level display label
would be a config-layer change, left to a future ticket. The one trust-sensitive review point: the emitted citation
set must remain exactly the cited-and-grounded intersection.
