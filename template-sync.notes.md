# template-sync notes

Human-readable context for `template-sync.json`. This file is deliberately
kept out of the JSON: the sync tool only reads `upstream`, `overwrite`, and
`merge`, and a `_comment_*` key is valid JSON but not part of the tool's
schema — it would drift or get stripped by editors. Keep
`template-sync.json` pure machine-readable config; record rationale here.

**Decision record:** the ownership policy (narrow overwrite list, fork-owned
prose, per-release review duty for adapted files) is ADR-0024
(`adr/0024-fork-template-sync-ownership-policy.md`, PR #105).

## The fork-owned adaptations (review per template release — ADR-0024 §4)

These template-shipped files are fork-adapted or fork-deleted and are
therefore NOT in `template-sync.json`. **Every sync PR must diff them
against the new template version and port relevant fixes by hand;** the
drift guard cannot see them:

- `AGENTS.md`, `docs/ARCHITECTURE.md` — fork prose, re-homed in #95
  (template's generic variants must never be adopted wholesale; #105's
  first attempt did and was reverted)
- `.github/workflows/ci.yml`, `staging.yml`, `deploy.yml`,
  `template-sync.yml` — Neon/Cloudflare/bun-1.4 fork infrastructure
- `playwright.config.ts`, `scripts/provision-cf.mjs` — D1-stripped (#54)
- `.agents/skills/guided-implementation/SKILL.md` — carries the
  KajianQ/DARS domain checklist
- `.agents/skills/code-review/SKILL.md` — philosophy/guardrail checks
  against the KajianQ pillars (pluggability, traceability, price-disciplined
  cost, server-authoritative state); the template's checklist assumes
  local-first CRDT, D1 sessions, and zero-cost-only — all deviations here.
  Template's "Posting contract" section is re-applied by hand on each sync.
- `.agents/skills/to-tickets/SKILL.md` — fork-specific note pointing at
  project-owned routing surfaces
- deleted: `docs/BOOTSTRAP_PROMPT.md`, `docs/QUOTA.md`,
  `docs/RUNBOOK_RESTORE.md`, `scripts/inject-d1-id.mjs` — D1-era artifacts
- `docs/ITERATION-GUARDRAIL.md`, `adr/0005-role-model-pins-honored-per-harness.md`,
  `docs/AGENT-USAGE-METADATA.md` — currently byte-identical to the template
  but fork-owned (not in the map) so upstream edits cannot bypass review

## Why the overwrite list is narrow (ADR-0024)

The sync map lists exactly the files kept byte-identical to the template
(subdirectory granularity where the whole subtree is adopted, e.g.
`.agents/skills/manager/`, `scripts/iteration-guardrail/`). Rationale:
#105's first iteration adopted the template's full overwrite list, which
made the 14 deliberate fork adaptations above permanent gate violations and
re-homed the fork's `AGENTS.md`/`docs/ARCHITECTURE.md` down to generic
template prose. Narrow entries keep the guard meaningful: anything listed
is enforced byte-identical (and a template deletion of a listed file is
adopted automatically), while anything the fork customizes is listed
nowhere and survives untouched. Cost: adopting a future template file is a
one-line manifest edit in a reviewed PR — that friction is the point.

## Why `.zcode/` is a merge path (aligned with template PR #130)

The template moved `.zcode/` from `overwrite` to `merge` in its PR #130:
hooks wiring in `.zcode/config.json` inherits template updates, but role
files are client-managed and this fork re-pins them to its own provider
channel (`custom:…`). `.zcode/agents/README.md` is the fork's role registry
(canonical stuck-report format, watchdog thresholds, context budgets cited
by the `manager` and `thermos-with-comments` skills) — kept even though the
template deleted its own copy in the same PR.

## Why ci.yml / staging.yml / template-sync.yml are in `merge` (not `overwrite`)

_Superseded by the narrow map (ADR-0024): the fork-adapted workflows are now
fork-owned by omission (in no list at all), which is stronger than `merge` —
merge-path conflicts still surface for manual resolution. Kept here for
history._ `ci.yml`, `staging.yml` and `template-sync.yml` moved from
`overwrite` to `merge`: fork CI/CD workflows wire fork-specific
infrastructure (NEON_DATABASE_URL into test; Cloudflare secrets + fork-owned
deploy steps that replaced the template's D1 flow; bun install + bun 1.4 for
the workspace-package imports in template-sync) into their steps, so they
are fork-owned in practice. Decided in #4's PR review; staging.yml re-forked
after a template auto-resolution regressed the #3 D1 strip;
template-sync.yml re-forked after the #54 Neon commit broke the sync run
(missing install, bun 1.3 lockfile mismatch).

## Why packages/hardening and .github/zap-rules.tsv are in `merge`/`overwrite`

`packages/hardening` (`@app/hardening`) is the template's single source of
truth for security headers (CSP, Permissions-Policy, COOP/CORP) and the SPA
catch-all serving rules — the KajianQ copy must stay identical to upstream so
template fixes land here via sync instead of fork-drifting (same reasoning as
`@app/rate`). `.github/zap-rules.tsv` is the sanctioned ZAP suppression list:
suppression entries carry their justification inline in the file, so it is
kept template-owned (synced) rather than edited ad hoc in the fork. Added
with the #38 header-hardening work; the upstream counterpart PR lands the
same files in the template repo.
