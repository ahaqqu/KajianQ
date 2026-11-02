# ADR-0068: A follow-up is routed from a bounded window of the session's own turns

## Decision

The router call carries a bounded tail window of the current session's prior
turns, so a question that names its topic only by reference can be decomposed
into retrieval sub-queries about the topic it refers to.

Prior turns may only resolve a reference. They never rewrite the caller's
verbatim question, never become retrieval evidence, and never reach the citation
gate: the sub-queries are the only thing history shapes. The caller's question
stays one of the searches, and an answer's citations must still be evidence this
run retrieved — a follow-up whose resolved search cannot ground it is refused
exactly as before.

A single-turn call's prompt is unchanged. The window is bounded in the product
domain rather than trusted from the caller, and every call still declares its
prompt personal data, so the prior turns cannot ride a free-tier vendor.

## Why

A follow-up's own words name no topic. Routed from them alone, the sub-queries
repeat the reference, the searches miss what the previous turn established, and
the generator's citation of that topic is refused as ungrounded — the product
answers a reasonable follow-up with a refusal it manufactured itself. The session
already holds what the reference points at, and the most recent turns are the
smallest input that resolves it: no memory store, no server-side synthesis, and
no rewriting of what the caller said.

Sending the whole session was rejected: the call's input and cost would grow
with the session, while an anaphor points at what was just said, so a fixed tail
is enough. Treating prior turns as evidence was rejected for the reason the
citation gate exists: earlier text is not a retrieved passage, and admitting it
as evidence would let one turn's mistake become the next turn's citation.

## Consequences

- The domain pack owns the window and the rule; the stage sends the turns and
  records how many it carried, so the trace shows that a follow-up's retrieval
  was resolved from prior turns.
- The router's input grows on every turn after the first, so the router role is
  no longer a constant cost per question. The per-turn cap is the lever, and the
  register names the router's payload.
- A question that stands on its own is routed from its own words. The rule
  states that arm; a real-model staging probe remains the acceptance check for a
  router that misreads a mid-session question as a follow-up.
- The citation gate, the refusal policy and the single-turn prompt are
  untouched, and no new processor or data category enters the register.
