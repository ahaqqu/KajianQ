# ADR-0029: Vite+ (`vp`) owns lint, format, and the check layer; builds, tests, and deploys keep their existing owners

## Status

Accepted (2026-09-06). Decision input: a toolchain review comparing "check layer only" against "full `vp` migration" under the constraints of ADR-0027 (Effect on `@effect/platform-bun`) and ADR-0028 (Alchemy owns provisioning and deploys).

## Context

The repo had no JavaScript linter or formatter and no `lint` gate: the `check` script is pure `tsc` (TypeScript 7, tsgo-based), CI is bun-only (`setup-bun`, frozen `bun.lock`), and two stale `eslint-disable` comments were the only trace of a linter ever existing. Lint debt was invisible and accumulating — the first Oxlint pass surfaced 27 pre-existing warnings.

Vite+ (VoidZero's `vp` CLI, `vite-plus` on npm) unifies Oxlint, Oxfmt, tsgo type-checking, Vitest, and Vite/Rolldown behind one CLI and one `vite.config.ts`. It recognizes bun as the package manager (bun.lock detection) and ships the `vp`/`oxlint`/`oxfmt` bins in the npm package, so a devDependency plus `bun run` covers everything — no global install, no Node runtime requirement on contributors' machines for the check path.

Full migration was considered and rejected for now (see Decision 4): `apps/api` is not a Vite project (dev/deploy are `alchemy dev`/`alchemy deploy` per ADR-0028, and the API runs on the bun runtime per ADR-0027), and `vp test` runs Vitest under vp's managed Node rather than bun, which would re-validate every test's runtime assumptions mid-Effect-migration.

A hard repo constraint shaped the decision: `template-sync.json`'s `overwrite` set (ADR-0024) must stay byte-identical to upstream. The template owns `tsconfig.json`, `vitest.config.ts`, `flake.nix`, and many `scripts/` — files a naive `vp migrate` would rewrite. Template-owned files are therefore excluded from the vp corpus entirely (derived from `template-sync.json` in `vite.config.ts`; mirrored in `.prettierignore`), which also means pre-existing lint warnings inside those files are upstream's to fix.

## Decision

1. **`vp check` is the lint/format gate.** `vite-plus` (pinned) is a root devDependency; `bun run lint` = `vp check` (Oxlint + Oxfmt check), `bun run fmt` = `vp fmt`. Configuration lives in the root `vite.config.ts`. The gate is blocking in CI (`ci.yml` `gate` job), consistent with "every gate blocking".
2. **Oxfmt is enforced, and the baseline was laid in one mechanical commit** (`vp fmt` across fork-owned files) so enforcement starts from a clean diff. Template-owned files are excluded via `.prettierignore`.
3. **`bun run check` stays `tsc`.** TypeScript 7 already is tsgo; vp's type-aware linting complements it, but tsc remains the type authority. No double gate, no config drift.
4. **Scope boundary: the check layer only.** `apps/web` keeps `vite dev`/`vite build`, tests stay on vitest under the bun runtime, package management stays bun, and `apps/api` stays `alchemy dev`/`alchemy deploy` (ADR-0028) on bun (ADR-0027). The approved follow-up — renaming web `dev`/`build` and root `test` to their `vp` equivalents after verifying vitest-under-Node compatibility — is a mechanical, low-risk PR that does not need a new ADR; anything beyond that (vp task runner, vp pack) does. _(Amended 2026-09-06: the follow-up landed — the full suite passes under `vp test` (384 tests, coverage thresholds held) and web dev/build run via `vp` with the existing PWA/Tailwind plugins; apps/api remains on bun + alchemy as before.)_
5. **Template ownership is respected structurally, not by exemption.** `vite.config.ts` reads `template-sync.json` and derives lint `ignorePatterns` from its `overwrite` list; `.prettierignore` mirrors the same set. A template update that changes ownership is picked up by regenerating nothing — the config reads the manifest at runtime.
6. **Local install** (for contributors and dev shells; `flake.nix` is template-owned and untouched): `curl -fsSL https://vite.plus | bash`, or simply use `bun run lint` / `bun run fmt`, which resolve the bins from `node_modules`.

## Consequences

- New blocking CI gate: `setup-vp` action + `bun run lint` in the `gate` job; `bun run lint` joins the Definition of Done gate list.
- The `truth` gate is satisfied by real importers (`vite.config.ts` imports `vite-plus`); no ALLOWLIST entry needed.
- The iteration-guardrail credits `bun run lint` through its existing `bun run (check|test|typecheck|lint)` pattern — the template-owned guardrail config needed no edit.
- 27 pre-existing lint warnings were fixed in fork-owned files as part of adoption; warnings in template-owned files arrive and leave with upstream.
- Formatting diffs will occasionally touch `.md`/`.yml`/`.json` outside source code (Oxfmt's default corpus); the `.prettierignore` boundary keeps template-owned docs byte-identical.
- `vite-plus` is young (0.x); version bumps are normal dependency churn, and the escape hatch is real — every capability it provides wraps a standard tool, and the repo's builds/tests do not depend on it.

## Revisit triggers

- The follow-up migration (decision 4) lands: web `dev`/`build`/root `test` switch to `vp` once vitest-under-Node compatibility is verified.
- `vite-plus` reaches 1.0 or `vp migrate` gains bun-runtime test support: re-evaluate `vp test` for the whole workspace.
- A template update adds files to the `overwrite` set that vp would format or lint: the derived ignore list updates automatically; no action needed beyond reviewing the diff.
