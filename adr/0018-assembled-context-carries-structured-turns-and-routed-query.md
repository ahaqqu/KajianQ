# ADR-0018: The assembled context carries structured turns and the routed query

## Decision

**The assembled context carries structured turns, not a rendered prompt string.** A turn is a role and its content, minimal and generic; the assembler owns context selection and ordering and the generator owns the final prompt it hands the provider. The engine treats the role as opaque, and the domain pack names the roles its templates use.

**The assembler receives the routed query and puts it on the context** — one query object, not two. Intent, sub-queries, filters, the router's account of its classification, and the run's verbatim question all travel with the context, so the generator and the reviewer read the router's reading in typed form instead of parsing it out of a string or rebuilding it.

**The runner, not the router, builds the routed query.** A router returns only what it understood; the runner stamps the caller's verbatim question and the caller's history onto it. Those are run state rather than routing results, so the stages downstream of routing receive one object whose question and prior turns are guaranteed present rather than echo fields a router could omit or get wrong.

**The query, the routed query, the assembled context and the stage interfaces are generic over the filter type.** They default to an open map for domain-agnostic callers, while the domain pack instantiates its own filter type, so the retriever gets typed filter access with no string re-casts at the boundary.

**The query carries an optional history of prior turns**, oldest first, passed through opaquely by the engine and rendered or ignored by the domain pack. Single-turn callers are unchanged, and the engine names no role or history semantics.

**Stage methods take a run context** — one trace collection point and per-run disposal — and the generator and reviewer return a draft rather than an answer.

## Why

A frozen prompt string at the seam inverts the ownership the rest of the design rests on: the assembler becomes the prompt renderer and the generator a forwarder, unable to re-template, stream a preamble or apply reviewer-driven reformatting without re-parsing. The generator is the one component that must branch the system prompt by intent, apply the citation discipline the filters carry, and refuse on insufficient evidence, and a rendered string at the seam makes all of that a parse.

Passing the routed query to the assembler is what makes carrying it on the context real: with the raw query alone the assembler rebuilt a lookalike, and the only question text it had rode the field named for intent — which is what the answer and review prompts then read. One query object closes that class of defect, because there is no second, plausible-looking source for a later stage to pick up by mistake. Stamping the verbatim text and the history in the runner is the same argument one level down: a router that does not produce them cannot omit them. History rides the run's query rather than an application-side side-channel, because a closure over mutable state or a second assembler breaks the runner's single-collection-point discipline.

Rejected: keeping the raw query and adding the routed one beside it, which leaves every future stage choosing between two overlapping query objects; passing the query beside the context in the generate signature, when it rides the context already; typing the filters as an untyped value at the engine boundary, which loses the default shape for domain-agnostic callers.

## Consequences

- The generator reads the verbatim question from the context's routed query, sends the turns to the provider, and records tokens, latency and cost on the trace.
- A second router implementation must return its own reading and let the runner stamp the question, so the stage interfaces move with this decision while the assembled context's own shape does not.
