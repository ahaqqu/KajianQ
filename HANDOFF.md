# Handoff prompt — KajianQ v1, session 2

Paste everything below the line into a fresh agent session.

---

## Mission

Implement **issue #3 — "P0: Monorepo foundation"** of `ahaqqu/KajianQ`. It is the only unblocked ticket on the board; finishing it unblocks #4 (RagStore + Neon schema) and #5 (Provider interface).

## Context you need

- The v1 spec is issue #1: `gh issue view 1 --repo ahaqqu/KajianQ` (skim for direction; your scope is only #3).
- Your ticket with acceptance criteria: `gh issue view 3 --repo ahaqqu/KajianQ`. **Those ACs are your definition of done** — including the two added after review: amend the forked AGENTS.md to record the ADR-0009 paid-API amendment to the template's free-tier guardrail, and create the NOTICES/DATASETS.md scaffold with attribution boilerplate.
- Read in the repo root: `CONTEXT.md` (domain glossary), `adr/0005` (monorepo engine+product), `adr/0009` (vendor allowlist). The other ADRs and `kajianq-dars-spec.md` are background only.
- Human ops prerequisites (issue #2) are done: vendor API keys exist, Sunnah.com key requested, Kemenag licensing verified, Neon extension support confirmed. You don't need the keys for #3 — #4/#5 will.
- Template source: `github.com/ahaqqu/agentic-project-template` (public). Import its code into this repo; wire template-sync so upstream fixes can flow in.

## Scope guardrails

- **Keep** from the template: Workers deploy pipeline, Hono API shell, React PWA (TanStack/Tailwind, en/id i18n), Valibot contracts, infra adapters, anonymous-session auth, Vitest/fast-check/Playwright-BDD, CI gates.
- **Drop**: D1, local-first sync, Notes tracer — fully removed, no dead references.
- **Create** workspace package skeletons: `rag-core` (pipeline interfaces: Router, Retriever, Assembler, Generator, Reviewer), `rag-ingest`, `eval`, `kajianq-domain`, alongside the template's `contracts` and `infra`.
- Engine packages (`rag-core`, `rag-ingest`, `eval`, `contracts`, `infra`) must contain **zero Islamic-domain logic** — enforce it with a boundary test or lint rule (AC4).
- Do NOT start #4/#5 work (no RagStore, no Provider implementations) — separate tickets.
- Minimal changes; follow the template's existing code style. Technical docs and code in English.

## Working agreements (user's rules — non-negotiable)

- **No `git commit`, push, or PR without explicit approval — ask each time.**
- PR title and description in English. Update PR title/body via `gh api --input` with a JSON payload file — never `gh pr edit --field body=...`.
- Do not close or modify issue #1. Tick #3's acceptance-criteria checkboxes as they complete (via `gh api --input` PATCH of the issue body).
- If anything in the ticket is ambiguous, ask the user before building.

## Done means

- All of #3's ACs verifiably true: staging PWA reachable via CI deploy, packages compile with typed interfaces exported, boundary test/lint green, template CI gates green on main, AGENTS.md amended, NOTICES/DATASETS.md created.
- Final report to the user: which ACs are checked off, staging URL, and what #4/#5 will need (e.g. `NEON_API_KEY`, vendor API keys added to GitHub Secrets / local env).
