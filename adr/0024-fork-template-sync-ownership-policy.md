# ADR-0024 — Fork template-sync ownership policy: narrow overwrite set, fork-owned prose

- **Status:** Accepted (2026-08-31)
- **Context:** template sync to `ahaqqu/agentic-project-template` `main` @ `efd4cc8` (PR #105), superseding the c6b05c3 sync attempt (PR #105's first iteration)
- **Deciders:** repo owner (via #105 review direction + template PR #128/#130 direction)
- **Supersedes:** the de-facto PR-#105-era plan to widen `template-sync.json` to the template's full overwrite list (`.agents/`, `.github/workflows/`, `.zcode/`, `AGENTS.md`, `docs/ARCHITECTURE.md`, `playwright.config.ts`, `scripts/`, …)
- **Amends:** nothing; complements ADR-0023 (pins honored per harness)

## Context

The template's sync map (`template-sync.json` in the template repo) grew
aggressively template-owned: `.agents/`, `.github/workflows/`, `AGENTS.md`,
`docs/ARCHITECTURE.md`, `playwright.config.ts`, `scripts/` wholesale, and
since #125/. PR #130 of the template reversed only `.zcode/` (overwrite →
merge). Enforcing that full list here fails `bun run template-gate` on 14
real, *deliberate* fork adaptations:

- **Fork-deleted template runbooks:** `docs/BOOTSTRAP_PROMPT.md`,
  `docs/QUOTA.md`, `docs/RUNBOOK_RESTORE.md` (D1/Cloudflare-specific; the
  fork runs Neon + `RagStore`, ADR-0008), and
  `scripts/inject-d1-id.mjs`.
- **Fork-adapted CI/CD:** `ci.yml`, `staging.yml`, `deploy.yml`,
  `template-sync.yml` (Neon wiring, Cloudflare secrets, bun 1.4 lockfile —
  recorded in `template-sync.notes.md` since PR #4).
- **Fork-adapted harness/provisioning:** `playwright.config.ts` and
  `scripts/provision-cf.mjs` (D1-stripped per #54).
- **Fork-owned prose:** `AGENTS.md` and `docs/ARCHITECTURE.md` were
  deliberately re-homed away from the template's notes-app forms in #95 —
  PR #105's first iteration re-adopted them, which stripped the fork's
  guardrails (DARS boundaries, working agreements, ticket model routing)
  and its ADR-cited architecture rationale down to the template's generic
  variants.
- **Fork-customized skills:** `guided-implementation` (the KajianQ/DARS
  domain checklist) and `to-tickets` (fork model-routing pointer).

## Decision

1. **`template-sync.json` lists exactly the files this fork keeps
   byte-identical to the template** (the "shared baseline"), at file and
   subdirectory granularity (e.g. `.agents/skills/manager/`, not
   `.agents/`), not the template's whole-directory entries. Concretely:
   all template skills except `guided-implementation`/`to-tickets`
   (fork-customized) and the two fork-added skills (which stay sanctioned
   additions regardless); the workflow scripts that carry no fork
   infrastructure; `scripts/template-sync/`, `scripts/iteration-guardrail/`,
   `scripts/agent-usage-metadata/` and the reusable check scripts;
   tsconfig triplet, `vitest.config.ts`, `flake.nix`, `.github/zap-rules.tsv`.
   `template-sync.json` itself is fork-owned (it *is* the fork's map).
2. **`.zcode/` follows the template's PR #130:** a `merge` path (never
   overwrite). Forks inherit template updates and may customize locally;
   this fork keeps its role-file pins on its ZCode custom-provider channel
   and preserves `.zcode/agents/README.md` (the role registry with the
   canonical stuck-report format and watchdog thresholds, still referenced
   by the `manager` and `thermos-with-comments` skills after template PR
   #130 deleted the template's copy).
3. **Prose stays fork-owned by omission** — `AGENTS.md`,
   `docs/ARCHITECTURE.md`, `docs/QUOTA.md`, `docs/RUNBOOK_RESTORE.md`,
   `docs/BOOTSTRAP_PROMPT.md` are not in the map at all, so upstream edits
   can never clobber the fork adaptations (the pre-#105 position,
   deliberately restored).
4. **The 14 template-shipped files the fork adapts/deletes are reviewed
   per template release, not silently:** every future sync PR diffs the
   fork's copies of the files in `template-sync.notes.md`'s "fork-owned
   adaptations" list against the new template version and ports relevant
   fixes by hand. The sync tool's drift guard does not and cannot enforce
   this — it is a review duty recorded here.
5. **Template PR #130's machinery changes are adopted as-is:** the
   `thoughtLevel`/pin preflight gate (`zcode-machinery-check.mjs`,
   `zcode-pin-check.mjs`) is retired; pin health surfaces at dispatch
   time (a non-resolving pin fails the spawn with a visible error and is
   fixed in the client's provider config, never by rerouting a committed
   pin — ADR-0023's doctrine stands). The role files' new frontmatter
   format (quoted strings, `color`, `injectAgentsMd`, per-role
   `skills:` lists) is adopted; this fork keeps its own channel refs
   (`custom:…`), not the template's caching-channel id, because the
   template's ref hard-codes its workspace id.

## Consequences

- `bun run template-gate` is green against upstream `main` again, and the
  CI `template-sync` job's seed-then-gate sequence works: seed against
  `ref=main` succeeds because no overwrite-listed file drifts; the merge
  auto-resolves overwrite conflicts to the template version, which is now
  byte-identical by construction for anything listed.
- Future template PRs that touch the 14 fork-owned adaptation files do not
  fail the gate — they are invisible to sync; checklist item 4 above is
  the safety net.
- The fork's prose (`AGENTS.md`, `docs/ARCHITECTURE.md`) is no longer
  periodically clobbered by sync merges or "re-home" steps; #105's
  first-iteration re-home of `AGENTS.md`/`docs/ARCHITECTURE.md` and the
  `reviewer.md` compliance-pointer relocation are reverted in favor of the
  fork originals.
- `.zcode/agents/README.md` (role registry: watchdog thresholds, stuck-report
  format, context budgets) is fork-maintained and survives template
  deletions.
- Cost: syncs now require a manifest edit whenever the fork wants to re-adopt
  a drifted file (or adopt a new template file). That friction is
  intentional — adoption should be a conscious per-file decision after
  #105's near-miss where adopting template prose silently deleted fork
  guardrails.