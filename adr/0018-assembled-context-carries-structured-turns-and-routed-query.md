# ADR-0018: AssembledContext carries structured turns and the routed query

## Decision

**The assembled context carries structured turns, not a rendered prompt string.** A turn is a role and its content,
minimal and generic; the Assembler owns context selection and ordering — principles first, then evidence — and the
Generator owns the final prompt it hands the provider. The engine treats the role as opaque, and the domain pack names
the roles its templates use.

**The assembled context carries the routed query.** Intent, sub-queries, and filters travel with it, so the
system-prompt branch and the citation discipline reach the Generator and the Reviewer in typed form instead of through
re-parsing a string.

**The query, the routed query, the assembled context, and the five stage interfaces are generic over the filter
type.** They default to an open string map for domain-agnostic callers, so the engine stays generic, while the domain
pack instantiates its own filter type and the Retriever gets typed filter access with no string re-casts at the
boundary.

**The query also carries an optional history of prior turns**, oldest first, passed through opaquely by the engine and
rendered or ignored by the domain pack's Assembler. The field is additive and optional: a single-turn caller is
unchanged, no stage signature moved, and the engine still names no role or history semantics.

Stage methods take a run context — one trace collection point and per-run disposal — and the Generator and Reviewer
return a draft rather than an answer, because the runner owns the final trace (ADR-0021).

## Why

A frozen prompt string at the seam inverts the ownership the rest of the design rests on: the Assembler becomes the
prompt renderer and the Generator a forwarder, unable to re-template, stream a preamble, or apply reviewer-driven
reformatting without re-parsing. The Generator is the one component that must branch the system prompt by intent,
apply the citation discipline the filters carry, and refuse on insufficient evidence, and a rendered string at the
seam makes all of that a parse. Carrying the routed query is the cheap version of the same property: without it the
Generator would need either a second construction site or a signature change to a just-shipped interface, and carrying
it on the context is additive. Making the interfaces generic over the filter type keeps the domain boundary intact
without erasing types — the engine never names a domain filter, and the domain pack's types stop being advisory.
Carrying conversation history on the query rather than re-threading it in the app is the same argument: the runner
passes the caller's query to the Assembler unchanged, whereas an app-side side-channel — a closure over mutable state,
a second assembler — would break the runner's single-collection-point discipline or fork the assembler per call site.
The turn shape is minimal on purpose. A richer message shape can grow later without breaking callers, and starting
from the smallest shape is what lets the Generator own assembly. Rejected: keeping the prompt string and adding the
query to the context, which leaves the Generator unable to re-template or stream a preamble and still forces
re-parsing for reviewer-driven reformatting — the stringly-typed prompt is the core smell. Rejected: changing the
generate signature to take the query beside the context, a breaking change to a just-shipped interface and unnecessary
because the query rides on the context. Rejected: typing the filters as unknown at the engine boundary, which loses
the default shape for domain-agnostic callers and forces every caller to cast.

## Consequences

The Generator reads the intent from the context's routed query for its system-prompt branch, sends the turns to the
provider, and records tokens, latency, and cost on the trace. The Retriever reads typed filters off the routed query
without re-casting; the Assembler produces the ordered turns and returns the context with the routed query attached.
The domain pack instantiates the typed query at the product boundary, and the engine never imports that type. A turn's
role being a string is deliberate: the engine does not name roles, and a shared role vocabulary, if one is ever
needed, lives in the domain pack.
