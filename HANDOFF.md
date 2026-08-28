# Handoff

**Decision recorded 2026-08-28: toolchain strategy = mise locally + CI-pinned
Bun (1.4.0), no Nix.** A full nix-flake unification (committed `flake.lock`,
direnv, all CI through `nix develop -c`) was implemented, fully green
(template ahaqqu/agentic-project-template#84, KajianQ #90), and **rejected by
the owner before merge** — prod runs on Cloudflare and the dev-shell parity
value was judged too small for the added tooling. Consequences every agent
must respect:

- `flake.nix` on `main` is **dormant template baggage** — do not activate it
  (no `.envrc`, no CI wiring, no AGENTS.md rule). Deleting it requires
  removing it from `template-sync.json`'s `overwrite` list too, or
  `template-gate` fails.
- CI pins `bun-version: 1.4.0` (was `latest`). Bumping Bun = one-line change
  per workflow + `bun install` if the lockfile format changes.
- Machine-level: Nix + direnv remain installed but idle; uninstall on request.
  mise provides bun 1.4.0 / gh locally.

This file holds the handoff prompt for in-flight work — open issues, decisions
already made by the user, the PR plan, and the per-PR verification checklist.
It is written at the start of a handoff session and cleared once its work is
merged. When a new handoff is needed, paste a fresh prompt below the line.

Standing rules: `AGENTS.md`. Architecture & plan: `SPECS.md`. Working
agreements: `AGENTS.md` §4.