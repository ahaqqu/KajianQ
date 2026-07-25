---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.
disable-model-invocation: true
---

# Grill With Docs

A structured interview that sharpens a plan or design into something implementation-ready, producing an ADR and a domain glossary as you go. Every question has a purpose: to expose ambiguity, find missing edges, or align the design with the architecture.

## Inputs

- A plan, design brief, or user description of what to build.
- `docs/ARCHITECTURE.md` — every design decision must survive a principle check.

## Phase 1 — Domain modeling

Before grilling, build a **domain glossary** — the shared vocabulary that will name types, routes, stores, and tables. A glossary built now prevents the drift where the same concept is named three ways in three layers.

1. Extract every noun the user used. List them. Ask: "Is this an entity (has identity and lifecycle), a value object (defined by its attributes), or an aggregate (the root of a consistency boundary)?"
2. Extract every verb. Ask: "Is this a command (synchronicity expected), an event (something that happened), or a query (no side effects)?"
3. Draw the boundaries. Group nouns and verbs into **bounded contexts** — areas where a term means one thing consistently. Flag terms that cross contexts with different meanings.
4. Name each concept with one canonical term. Record it in the glossary. This is the **ubiquitous language** — it will name your Zod schemas, table columns, and route segments.

Output: a draft glossary of terms, their type (entity/value/aggregate/event/command), and which bounded context they belong to.

## Phase 2 — Grilling

Now interrogate the design. Each question probes a specific failure mode. Do not stop at the first answer — follow up until the answer is concrete enough to implement.

### Architecture alignment

For each principle in `docs/ARCHITECTURE.md`, ask:

- **Cost**: What happens at 100k requests/day? What degrades first?
- **Local-first**: Does the user need the network for this to work? What offline behavior is expected?
- **Performance**: What's the happy-path latency? What's the 95th percentile?
- **Cross-Platform**: Does this behave differently on mobile? On iOS Safari specifically?
- **Polished**: What does the empty state look like? The error state? The loading state?
- **Secure**: Who can access this? What authorization is at play?
- **Observable**: What log line tells you this succeeded? What log line tells you it failed?
- **Maintainable**: Will an adapter hide this external service?
- **Available**: What happens when the external service is down? What retries?
- **Reliable**: What test proves this works? What test proves it handles failure?
- **Reproducible**: Any new dependencies not in the Nix flake?
- **Agentic**: Can this module be understood in isolation?

### Design pressure testing

- "What's the simplest input that should work? What's the simplest input that should fail?"
- "What happens if this is called twice in rapid succession?"
- "What's the maximum size this will handle? What breaks at size+1?"
- "What data does this design assume exists? What if it's missing?"
- "What race condition is possible between two concurrent users? Between two concurrent requests?"
- "If we ship this and it's wrong, what's the blast radius? Data loss? Double charge? Silent corruption?"
- "What happens in six months when this design has outgrown its initial assumptions?"

### Completeness check

Every user action must have answers for:
- The happy path (one sentence)
- The auth check (who, what role)
- The validation (what Zod schema, what edge cases)
- The error path (what specific error, what the user sees)
- The data flow (which stores, which adapters, which routes)
- The test seam (where you'd wire a test to verify this exact behavior)

## Phase 3 — ADR

Write an Architecture Decision Record for any decision that is:
- A structural tradeoff (two viable paths, one chosen)
- A constraint the team must remember
- A departure from ARCHITECTURE.md defaults

### ADR template

```markdown
# ADR-<NNN>: <title>

**Status:** proposed | accepted | superseded
**Date:** YYYY-MM-DD

## Context

What is the problem we're solving? What constraints are we under?

## Decision

What did we decide? One sentence.

## Rationale

Why this over the alternatives? What does this enable downstream?

## Consequences

What becomes easier? What becomes harder? What must we remember?
```

Write the ADR under `adr/` and number it sequentially.

## Phase 4 — Glossary

Finalize the domain glossary. Each entry:

```markdown
### <Term>

**Type:** entity | value object | aggregate | event | command | query
**Context:** <bounded context name>
**Definition:** one sentence that makes the term unambiguous in every context it appears.
**Also known as:** <rejected aliases — names we deliberately did NOT use>
```

Write it to `docs/GLOSSARY.md`.

## Completion criterion

Grilling is done when:
- [ ] Every architecture principle has been checked against the design.
- [ ] Every design pressure question has a concrete answer (no "we'll figure it out later").
- [ ] The glossary covers every noun and verb in the design with unambiguous definitions.
- [ ] Every structural decision has an ADR, or a note explaining why it doesn't need one.
- [ ] The user has reviewed and approved the glossary and ADRs.
