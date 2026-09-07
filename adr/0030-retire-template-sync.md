# ADR-0030 — Retire template-sync from KajianQ

**Status:** Accepted (2026-09-08).  
**Context:** Issue #? (workflow overhead reduction).  
**Supersedes:** ADR-0024's operational half — ownership policy remains historical, but no future upstream sync is enforced.

## Problem

The `agentic-project-template` upstream was forked early. The fork has drifted far enough that maintaining `template-sync.json`, the `.template-sync.state` seed, and the `template-gate` CI job consumes more overhead than value. Files the template owns (`overwrite` list) are no longer pulled cleanly: every sync run produces large, manually-resolved conflicts, and the gate frequently fails on drift that is intentional.

## Decision

1. **Stop syncing.** Delete `template-sync.json`, `.template-sync.state`, `.template-sync.pending`, and the `scripts/template-sync/` implementation.
2. **Remove the gate.** Drop `bun run template-gate` from `package.json`, CI, and the Definition of Done in `AGENTS.md`.
3. **Delete the scheduled workflow.** Remove `.github/workflows/template-sync.yml`.
4. **Keep the history.** ADR-0024 and `template-sync.notes.md` stay as records of why the policy existed; they are marked superseded by this ADR but not deleted.
5. **Fork ownership going forward.** Every file in this repo is now project-owned. Where we want to borrow upstream improvements, we cherry-pick explicitly rather than sync mechanically.

## Consequences

- The template's future improvements will not flow automatically. The trade-off is accepted: the project is mature enough that unvetted upstream changes are more dangerous than helpful.
- `bun run truth` (`scripts/check-template-truth.mjs`) is also removed because its purpose was to enforce no-dependency-without-an-importer across template-owned scripts that no longer exist. The same check is now subsumed by `bun run boundary` and existing import linting.
- `vite.config.ts` no longer derives lint/prettier ignores from `template-sync.json`; it uses an explicit in-repo list.
- `packages/contracts/src/template-sync.ts` and its tests are deleted because they model a manifest that no longer exists.
- CI is simpler and faster by one job and one gate.

## Alternatives considered

- **Partial sync** (keep template-owned tooling files, vendor skills). Rejected: the tooling files are exactly what drifted and caused the most merge pain; keeping them would preserve the overhead we want to remove.
- **Manual sync only, keep gate.** Rejected: the gate enforces byte-identical copies of files we no longer want to be identical; a manual gate still requires maintaining `template-sync.json` and the state file.

## Evidence of acceptance

- `template-sync.json` deleted; `bun run template-gate` no longer exists; CI passes without it.
