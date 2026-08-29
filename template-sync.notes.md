# template-sync notes

Human-readable context for `template-sync.json`. This file is deliberately
kept out of the JSON: the sync tool only reads `upstream`, `overwrite`, and
`merge`, and a `_comment_*` key is valid JSON but not part of the tool's
schema — it would drift or get stripped by editors. Keep
`template-sync.json` pure machine-readable config; record rationale here.

## Why ci.yml / staging.yml / template-sync.yml are in `merge` (not `overwrite`)

`ci.yml`, `staging.yml` and `template-sync.yml` moved from `overwrite` to
`merge`: fork CI/CD workflows wire fork-specific infrastructure (NEON_DATABASE_URL
into test; Cloudflare secrets + fork-owned deploy steps that replaced the
template's D1 flow; bun install + bun 1.4 for the workspace-package imports in
template-sync) into their steps, so they are fork-owned in practice. Decided in
#4's PR review; staging.yml re-forked after a template auto-resolution
regressed the #3 D1 strip; template-sync.yml re-forked after the #54 Neon
commit broke the sync run (missing install, bun 1.3 lockfile mismatch).

## Why packages/hardening and .github/zap-rules.tsv are in `merge`

`packages/hardening` (`@app/hardening`) is the template's single source of
truth for security headers (CSP, Permissions-Policy, COOP/CORP) and the SPA
catch-all serving rules — the KajianQ copy must stay identical to upstream so
template fixes land here via sync instead of fork-drifting (same reasoning as
`@app/rate`). `.github/zap-rules.tsv` is the sanctioned ZAP suppression list:
suppression entries carry their justification inline in the file, so it is
kept template-owned (synced) rather than edited ad hoc in the fork. Added
with the #38 header-hardening work; the upstream counterpart PR lands the
same files in the template repo.

## Why docs/ is NOT in the sync map

The upstream template lists `docs/ARCHITECTURE.md`, `docs/BOOTSTRAP_PROMPT.md`,
`docs/QUOTA.md`, and `docs/RUNBOOK_RESTORE.md` as template-owned; this fork
deliberately dropped all `docs/` entries at fork setup:

- `docs/ARCHITECTURE.md` describes the template's product philosophy —
  zero-cost Cloudflare-only, local-first CRDT sync, D1 — and predates DARS
  entirely. Two of its foundational pillars are superseded here by decision
  (ADR-0009: paid LLM/embedding APIs accepted in the critical path; local-first
  dropped with D1 per spec §3.1, ADR-0008), so syncing it verbatim would make
  agents treat a partially-wrong document as authoritative. The fork instead
  keeps its own fork-adapted `docs/ARCHITECTURE.md` (stable "why" layer, marks
  each template pillar Inherited or Deviated with the ADR cited) — fork-owned,
  NOT in `overwrite`/`merge`, so upstream edits cannot clobber the adaptations.
- The fork's architecture truth is `SPECS.md` (living document, AGENTS.md §2
  rule 16) plus `adr/0005`–`0023`; the template's QUOTA/RUNBOOK/BOOTSTRAP docs
  describe template-specific runbooks (D1 Time Travel restore, quota headroom)
  that do not apply to the Neon/RagStore foundation.
- The `.agents/skills/` directory IS a merge path, so template skills that say
  "read docs/ARCHITECTURE.md" resolve against the fork's own adapted file.
