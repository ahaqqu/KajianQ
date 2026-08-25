---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
disable-model-invocation: true
---

# Grilling

Interview the user relentlessly about every aspect of a plan, design, or decision until you reach a shared understanding. Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

## Rules

- **One question at a time.** Wait for feedback on each question before continuing. Asking multiple questions at once is bewildering.
- **Look up facts yourself.** If a fact can be found by exploring the environment (filesystem, tools, code, `docs/ARCHITECTURE.md`, `CONTEXT.md`), look it up rather than asking the user.
- **Decisions belong to the user.** Put every true decision to the user and wait for their answer. Do not assume consensus.
- **Do not act until confirmed.** Do not start implementing until the user confirms you have reached a shared understanding.

## Use in this repo

For a structured grilling session that also produces ADRs and a domain glossary, use this skill through the `grill-with-docs` orchestrator (`.agents/skills/grill-with-docs/SKILL.md`). That orchestrator adds the architecture-principle checklist and doc-writing phases on top of this discipline.

## Completion criterion

The grilling is done when the user confirms a shared understanding of the decision tree and all load-bearing choices.
