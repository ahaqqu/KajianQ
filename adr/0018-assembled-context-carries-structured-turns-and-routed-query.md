# ADR-0018: AssembledContext carries structured turns and the routed query

## Decision

**The assembled context carries structured turns, not a rendered prompt string.** A turn is a role and its content,
minimal and generic; the Assembler owns context selection and ordering — principles first, then evidence — and the
Generator owns the final prompt it hands the provider. The engine treats the role as opaque, and the domain pack names
the roles its templates use.

**The Assembler receives the routed query and puts it on the context.** `assemble(routed, chunks)` — one query object,
not two. Intent, sub-queries, filters, the router's account of its classification, and the run's verbatim question all
travel with the context, so the Generator and the Reviewer read the router's reading in typed form instead of parsing
it out of a string or rebuilding it.

**The runner, not the Router, builds the routed query.** A Router returns only what it understood; the runner stamps
the caller's verbatim `sourceText` and the caller's `history` onto it. Those are run state, not routing results, so the
stages downstream of routing receive one object whose question and prior turns are guaranteed present rather than echo
fields a router could omit or get wrong.

**The query, the routed query, the assembled context, and the five stage interfaces are generic over the filter
type.** They default to an open string map for domain-agnostic callers, while the domain pack instantiates its own
filter type and the Retriever gets typed filter access with no string re-casts at the boundary.

**The query carries an optional history of prior turns**, oldest first, passed through opaquely by the engine and
rendered or ignored by the domain pack's Assembler. Single-turn callers are unchanged and the engine names no role or
history semantics.

**Stage methods take a run context** — one trace collection point and per-run disposal — and the Generator and
Reviewer return a draft rather than an answer.

## Why

A frozen prompt string at the seam inverts the ownership the rest of the design rests on: the Assembler becomes the
prompt renderer and the Generator a forwarder, unable to re-template, stream a preamble, or apply reviewer-driven
reformatting without re-parsing. The Generator is the one component that must branch the system prompt by intent, apply
the citation discipline the filters carry, and refuse on insufficient evidence, and a rendered string at the seam makes
all of that a parse. Passing the routed query to the Assembler is what makes carrying it on the context real: with the
raw query alone the assembler rebuilt a lookalike, and the only question text it had rode the field named `intent`,
which is what the answer and review prompts then read. One query object closes that class of defect — there is no
second, plausible-looking source for a later stage to pick up by mistake. Stamping the verbatim text and the history in
the runner rather than in each Router is the same argument one level down: a router that does not produce them cannot
omit them, and no reader has to ask which of two query objects is authoritative. History rides the run's query rather
than an app-side side-channel — a closure over mutable state, a second assembler — because those break the runner's
single-collection-point discipline or fork the assembler per call site. The turn shape stays minimal on purpose: a
richer message shape can grow later without breaking callers, and starting from the smallest shape is what lets the
Generator own assembly.

Rejected: keeping the raw query on the seam and adding the routed one beside it, which leaves every future stage
choosing between two overlapping query objects. Rejected: changing the generate signature to take the query beside the
context, since the query rides on the context already. Rejected: typing the filters as unknown at the engine boundary,
which loses the default shape for domain-agnostic callers.

## Consequences

The Generator reads the verbatim question from the context's routed query and sends the turns to the provider,
recording tokens, latency, and cost on the trace. The Retriever reads typed filters off the routed query without
re-casting, and a deterministic rule keyed on what the user actually asked reads the stamped verbatim text. The domain
pack instantiates the typed query at the product boundary, and the engine never imports that type. A turn's role being
a string is deliberate: the engine does not name roles, and a shared role vocabulary, if one is ever needed, lives in
the domain pack. One stage signature moved for this — `Assembler.assemble` — and the assembled context's own shape is
unchanged.
