---
name: domain-modeling
description: Build and sharpen the project's domain model. Use when the user wants to pin down domain terminology or a ubiquitous language, record an architectural decision, or when another skill needs to maintain the domain model.
---

# Domain Modeling

Actively build and sharpen the project's domain model as you design. This is the *active* discipline — challenging terms, inventing edge-case scenarios, and writing the glossary and decisions down the moment they crystallise.

## Inputs

- A plan, design brief, or user description of what to build.
- `CONTEXT.md` and `docs/ARCHITECTURE.md` — existing terms and architecture constraints.
- Any existing ADRs in `adr/`.

## File structure

This repo is single-context. Maintain one glossary at the root and ADRs under `adr/`:

```
/
├── CONTEXT.md                ← concise mental model (already exists)
├── docs/
│   └── ARCHITECTURE.md       ← architecture principles
├── adr/                      ← architecture decision records
└── .agents/skills/...        ← skills (do not write here)
```

Create files lazily — only when you have something to write. If a term is resolved, capture it immediately; don't batch.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in `CONTEXT.md` or `docs/GLOSSARY.md`, call it out immediately: "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term: "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update the glossary inline

When a term is resolved, update `docs/GLOSSARY.md` right there. Don't batch these up — capture them as they happen. Use this format:

```markdown
### <Term>

**Type:** entity | value object | aggregate | event | command | query
**Context:** <bounded context name>
**Definition:** one sentence that makes the term unambiguous in every context it appears.
**Also known as:** <rejected aliases — names we deliberately did NOT use>
```

`docs/GLOSSARY.md` should be totally devoid of implementation details. Do not treat it as a spec, scratch pad, or repository for implementation decisions. It is a glossary and nothing else.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful.
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons.

If any of the three is missing, skip the ADR.

Use this ADR format:

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

## Completion criterion

Domain modeling is done when:
- [ ] Every noun and verb in the design has an unambiguous definition in `docs/GLOSSARY.md`.
- [ ] Every structural decision that meets the ADR threshold has an ADR, or a note explaining why it doesn't need one.
- [ ] The user has reviewed and approved the glossary and ADRs.
