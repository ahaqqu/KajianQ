# Agentic Project Template

A template for full-stack TypeScript projects built with Cloudflare Workers, React, and AI-assisted development. Mirrors the architecture, guardrails, and skill suite described in `docs/ARCHITECTURE.md`.

## Structure

```
.
├── docs/
│   └── ARCHITECTURE.md    # Philosophy — why the system is built this way
├── AGENTS.md              # Normative guardrails for implementing agents
├── .agents/
│   └── skills/            # Agent skills: plan, implement, review, diagnose, ship
└── .commandcode/
    └── skills/            # Mirror of .agents/skills/ for alternate harness
```

This template is a **meta-project**. It contains no application code — it defines the rules, conventions, skills, and architecture that agents and humans follow to build a correct, high-quality product. The actual scaffold (monorepo layout, `flake.nix`, CI workflows, `wrangler.toml`) is generated at project start.

## Principles

The architecture is organized around 12 gated principles:

1. **Cost** — zero-cost free tier (Cloudflare free quotas)
2. **Local-first** — works without network (Tinybase MergeableStore CRDT)
3. **Performance** — fast on slow hardware (<200 KB gzipped bundle)
4. **Cross-Platform** — PWA for Web, Android, iOS
5. **Polished** — responsive, accessible, localized (en + id)
6. **Secure** — defense in depth (Zod, Better Auth, secure headers)
7. **Observable** — structured logs, correlation IDs, Sentry
8. **Maintainable** — adapter pattern, stateless Workers, standard SQL
9. **Available** — graceful degradation, exponential backoff, D1 Time Travel
10. **Reliable** — contracts-first, property tests, BDD, >80% coverage
11. **Reproducible** — Nix Flakes, identical dev environment everywhere
12. **Agentic** — 300-line files, explicit contracts, self-describing structure

Each principle is enforced by an automated CI gate. See `docs/ARCHITECTURE.md` for the full rationale.

## Stack

| Layer | Choice |
|---|---|
| Platform | Cloudflare Workers + D1 + R2 |
| API | Hono RPC + zod-openapi |
| Client | React 19 + TanStack Router + TanStack Query |
| State | Tinybase MergeableStore CRDT |
| UI | shadcn/ui + Tailwind CSS |
| Auth | Better Auth |
| Sync | Batched POST /v1/sync |
| Testing | Vitest + fast-check + Playwright-BDD |
| Dev env | Nix Flakes |
| Tooling | Vite+ (`vp` task runner) |

## Skill flow

The skills form a complete development pipeline. **[auto]** fires on its own when the agent detects a match; **[you]** must be manually invoked by the human.

```
bootstrap-project
       │
       ▼
grill-with-docs
       │
       ▼
    to-spec
       │
       ▼
  to-tickets
       │
       ▼  
  plan-review
       │
       ▼
guided-implementation
       │
       ▼
 writing-tests [auto]
       │
       ▼
  pr-creation [auto]
       │
       ▼
   code-review
       │
       ▼
     ship
       │
       ▼
   production

Any step can branch to:
  diagnosing-bugs              (find + fix bugs)
  payment-integration          (payments/webhooks)
  writing-great-skills         (improve skills themselves)
```

## Skill index

| Skill | Purpose |
|---|---|
| `bootstrap-project` | Scaffold the full monorepo, flake.nix, CI, and tooling from scratch |
| `plan-review` | Validate plans against architecture |
| `grill-with-docs` | Interview to sharpen designs; produce ADRs and glossary |
| `to-spec` | Synthesize conversation into a published spec |
| `to-tickets` | Break specs into tracer-bullet tickets |
| `guided-implementation` | Implement a plan with guardrail checks |
| `writing-tests` | Write unit, property, BDD, and integration tests |
| `code-review` | Review PRs for philosophy and guardrail compliance |
| `diagnosing-bugs` | Tight feedback-loop-first debugging |
| `pr-creation` | Create PRs with validated DoD |
| `ship` | Deploy to staging, validate gates, promote to production |
| `payment-integration` | Payment flows, webhooks, entitlements |
| `writing-great-skills` | Reference for writing effective agent skills |

## Prerequisites

- Nix (for reproducible dev shell via `flake.nix` — generated at scaffold)
- Cloudflare account (for `wrangler` deployment)
- Bun (bundled in the Nix flake)

## Quick start

This template is not directly runnable. To use it for a new project:

1. Clone this template.
2. Scaffold the monorepo (see `docs/ARCHITECTURE.md` for layout).
3. Set up the Nix flake, CI workflows, `wrangler.toml`, and tooling.
4. Implement features guided by the skills in `.agents/skills/`.

For detailed rules agents must follow, see `AGENTS.md`.
