---
name: code-review
description: Use when reviewing a pull request after it is created. Read docs/ARCHITECTURE.md for philosophy alignment and AGENTS.md for guardrail compliance.
---

# Code Review

Use this skill when reviewing a pull request after it has been created.

## Inputs

- The pull request diff.
- `docs/ARCHITECTURE.md` — verify the changes align with philosophy.
- `AGENTS.md` — verify the changes comply with guardrails.

## Philosophy alignment

For each principle in `docs/ARCHITECTURE.md`, check if the PR upholds or violates it:

- **Cost**: Does the PR add paid dependencies? Does it move compute to the edge that belongs on the client?
- **Local-first**: Does the PR preserve CRDT merge semantics? Does it block the UI on network?
- **Performance**: Does the PR increase bundle size? Does it add runtime CSS-in-JS?
- **Cross-Platform**: Does the PR introduce platform-specific code?
- **Polished**: Does the PR include i18n for `en` + `id`? Does it consider accessibility?
- **Secure**: Does the PR touch auth, payments, or external boundaries without Zod validation?
- **Observable**: Does the PR add logging without the Logger adapter?
- **Maintainable**: Does the PR access `env.*` directly? Does it add Cloudflare-specific types to business logic? Does it change schema without migrations?
- **Available**: Does the PR fail hard instead of degrading gracefully?
- **Reliable**: Does the PR lack tests for changed logic? Does it reduce coverage?
- **Reproducible**: Does the PR introduce tools not in the Nix flake?
- **Agentic**: Are files small and self-describing? Are contracts clear?

## Guardrail compliance

For each changed file, verify against `AGENTS.md` universal guardrails and the `guided-implementation` domain checklist:

- External service access uses adapters in `packages/infra`. No direct `env.*` access.
- Routes have Zod schemas in `packages/shared-zod`, use `@hono/zod-openapi`, and are under `/v1/`.
- Database changes include Drizzle migrations, client migrations, and `SCHEMA_VERSION` bump.
- User-facing strings are externalized for `en` and `id`. No hardcoded copy.
- Dates, numbers, and currency use the `Intl` API.
- Styling uses Tailwind CSS only. No runtime CSS-in-JS.
- Sync logic uses Tinybase MergeableStore CRDT. No hand-rolled last-write-wins.
- Sync retries with exponential backoff; requests carry `schemaVersion` and `clientVersion`.
- Logging uses the Logger adapter with structured JSON. No `console.log`.
- SQL uses only standard features. No SQLite-specific or D1-specific extensions.
- Session storage uses D1. No KV write-path.
- Dependencies are free-tier compatible. No paid services in the critical path.
- Secrets are injected via `wrangler secret`. Nothing committed to the repo.
- Files are 300 lines or fewer with 5 or fewer direct dependencies.
- Webhook handlers verify signatures before parsing; are idempotent.

## Output

Report:
- Philosophy violations: which principle is violated, which file, and why.
- Guardrail violations: which rule is broken, which file and line.
- Approval or rejection with justification.

Block the PR on any MUST or MUST NOT violation. Flag SHOULD violations for author response.
