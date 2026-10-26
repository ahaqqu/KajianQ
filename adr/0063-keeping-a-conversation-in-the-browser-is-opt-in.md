# ADR-0063: Keeping a conversation in the browser is opt-in

## Decision

The chat asks before it keeps anything about a conversation in the browser, and
keeps nothing there until the reader agrees. The two answers are "keep it here"
and "keep nothing"; the answer is itself remembered, so the question is asked
once, and it can be changed from the conversation-history drawer without leaving
the chat.

Persistence is gated in one place — the browser-storage wrapper every chat key
writes through — not per call site, so the rule covers the anonymous token, the
active session id and the history list alike. Until "keep it here" is chosen
those keys live in memory for the tab: the conversation works, survives no
reload, and leaves nothing behind when the tab closes. "Keep nothing" also erases
what an earlier visit stored, and a later grant writes the state already in
memory, so the conversation that earned the grant is the one it keeps.

The theme preference is outside the gate: it holds no conversation and no
personal data, and the notice lists it with the rest of the browser storage.

## Why

The product tells readers their conversation is kept in their browser. That is a
convenience they can decline — the chat answers whether or not anything is
kept — so making it a condition of use, or keeping it silently, would make the
notice describe a choice the reader never made. Asking once, in the chat, at the
moment the promise applies, is where the choice is meaningful; a preference
buried in a settings page asks no one.

Server-side retention is not this decision. The answer is stored by the service
it already describes; declining changes only what this browser keeps.

Rejected: a blocking gate that makes the question a condition of asking; implicit
consent through continued use, which the notice's wording would then overstate;
and a per-conversation question, which would nag for a decision whose answer does
not change per conversation.

## Consequences

- A browser that has never answered keeps nothing, and a reload starts a new
  anonymous session — the chat's "return where you left off" is the granted
  state only.
- One stored choice, named in the notice's browser-storage line beside the keys
  the gate covers.
- Withdrawing consent erases the stored keys; the open conversation stays on
  screen for the tab and is forgotten when it closes.
- The server keeps no record of the choice: it is a browser-side fact, so the
  gate lives behind the storage wrapper and no API route knows about it.
