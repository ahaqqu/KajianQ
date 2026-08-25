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
