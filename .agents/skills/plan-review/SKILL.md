---
name: plan-review
description: Use when reviewing a proposed plan or validating that an existing plan aligns with architecture. Read docs/ARCHITECTURE.md for philosophy and rationale.
---

# Plan & Review

Use this skill when reviewing a proposed plan or validating that an existing plan aligns with architecture.

## Inputs

- The plan document or proposal.
- `docs/ARCHITECTURE.md` — read fully before evaluating the plan.

## Evaluation checklist

For each principle in `docs/ARCHITECTURE.md`, verify the plan addresses it:

- **Cost**: Does the plan add paid dependencies? Does it introduce polling or per-request edge compute that belongs on the client?
- **Local-first**: Does the plan touch sync? Does it preserve CRDT merge and idempotency?
- **Performance**: Does the plan affect bundle size? Does it add runtime CSS-in-JS?
- **Cross-Platform**: Does the plan introduce platform-specific code?
- **Polished**: Does the plan include i18n for `en` + `id`? Does it consider accessibility?
- **Secure**: Does the plan touch auth, payments, or external boundaries? Does it use Valibot validation from `@app/contracts`?
- **Observable**: Does the plan add logging? Does it use the Logger adapter?
- **Maintainable**: Does the plan add adapters for new external services? Does it change the database schema?
- **Available**: Does the plan handle failure gracefully? Does it degrade rather than crash?
- **Reliable**: Does the plan include tests? Does it define contracts before implementation?
- **Reproducible**: Does the plan introduce new tools not in the Nix flake?
- **Agentic**: Can each module be understood in isolation? Are contracts clear?

## Output

Report what the plan covers, what it misses, and what violates architecture. Do not approve a plan that violates a principle without explicit user approval.

Severity on each finding:

- **BLOCK** — MUST/MUST NOT violation; plan cannot proceed
- **FLAG** — SHOULD fix before implement; needs user decision
- **NOTE** — observation only

This repo is already a working monorepo (no bootstrap). Plans must extend the existing layout in `CONTEXT.md`, not invent a new scaffold.
