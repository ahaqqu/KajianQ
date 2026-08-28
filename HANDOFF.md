# Handoff

**Active: Nix toolchain unification (two-PR plan).** Opened 2026-08-28.

## PRs in flight

1. **Template first** — ahaqqu/agentic-project-template#84
   `chore(ci): pin toolchain via committed flake.lock, nix develop`
   (branch `chore/nix-pinned-toolchain`). Nixifies all 7 template workflows
   (`cachix/install-nix-action@13d8dd58` + `nix develop -c`), commits
   `flake.lock` (nixos-unstable @ 9fbb54b → Bun 1.3.13), adds `.envrc`,
   AGENTS.md Universal rule, ARCHITECTURE.md §11/§13 updates. **Agent must
   not merge; merge with a merge commit.**
2. **KajianQ** — branch `chore/nix-toolchain-unification`
   Commits `flake.lock` + regenerated `bun.lock` (nixpkgs bun 1.3.13,
   lockfile v1 — the old lock was written by mise's Bun 1.4.0), nixifies
   merge-listed `ci.yml`/`staging.yml`, adds AGENTS.md §4 rule + §13/§15
   doc updates. `e2e.yml`/`vuln-scan.yml`/`flake.nix` are overwrite-listed →
   they land via template sync after template #84 merges (run
   `bun run template-sync update` on a sync PR then).

## Verification already done (inside `nix develop -c`)

- KajianQ: check (10 workspaces) / test (161 passed, 93.18% cov) / build /
  size-limit (125.03 kB < 200 kB) / agentic-limits / boundary / truth — green.
- Template: check / test (187 passed, 93.97% cov) / agentic-limits / truth /
  template-gate (self-skips in template root) — green.

## Follow-ups after merge

- After template #84 merges: template-sync PR to pull nixified
  `e2e.yml`/`vuln-scan.yml`/`flake.nix` into KajianQ.
- Machine-level (not repo): remove `bun`/`gh` pins from
  `~/.config/mise/config.toml` — keep mise for codex/pi/node (DSH runs on
  mise's node 26.7.0).
- Optional: `cache-nix-action` for CI nix-store caching.

This file holds the handoff prompt for in-flight work — open issues, decisions
already made by the user, the PR plan, and the per-PR verification checklist.
It is written at the start of a handoff session and cleared once its work is
merged. When a new handoff is needed, paste a fresh prompt below the line.

Standing rules: `AGENTS.md`. Architecture & plan: `SPECS.md`. Working
agreements: `AGENTS.md` §4.