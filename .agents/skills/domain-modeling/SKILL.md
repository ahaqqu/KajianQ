---
name: domain-modeling
description: Build and sharpen the project's domain model — pin down terminology, maintain the glossary and ADRs. Reached through `grill-with-docs`, or loaded directly for focused terminology or ADR work.
disable-model-invocation: true
source: https://github.com/mattpocock/skills/blob/main/skills/engineering/domain-modeling/SKILL.md
synced: 2026-08-29
modified: true
---

# Domain Modeling

Actively build and sharpen the project's domain model as you design. This is the _active_ discipline — challenging terms, inventing edge-case scenarios, and writing the glossary and decisions down the moment they crystallise.

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
├── adr/                      ← product and architecture decision records
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

Whether a decision earns a record is stated once, in `AGENTS.md`'s Decisions
bullet — read the bar there before offering one. `adr/TEMPLATE.md` is the shape to
copy. Most sessions have no ADR to write.

## Completion criterion

Domain modeling is done when:

- [ ] Every noun and verb in the design has an unambiguous definition in `docs/GLOSSARY.md`.
- [ ] Every decision the `AGENTS.md` bar makes a record has one, or a note explaining why it doesn't need one.
- [ ] The user has reviewed and approved the glossary and ADRs.
