# ADR-0029: Vite+ (`vp`) owns the check layer plus the web dev/build/test surface; the API stays bun + Alchemy

## Status

Accepted (2026-09-06). Amended 2026-09-06 (same day): the staged follow-up landed — `apps/web` dev/build/preview and the root test suite now run via `vp` after the vitest-under-Node compatibility gate passed. Decision input: a toolchain review comparing "check layer only" against "full `vp` migration" under the constraints of ADR-0027 (Effect on `@effect/platform-bun`) and ADR-0028 (Alchemy owns provisioning and deploys).

## Context

The repo had no JavaScript linter or formatter and no `lint` gate: the `check` script is pure `tsc` (TypeScript 7, tsgo-based), CI is bun-only (`setup-bun`, frozen `bun.lock`), and two stale `eslint-disable` comments were the only trace of a linter ever existing. Lint debt was invisible and accumulating — the first Oxlint pass surfaced 27 pre-existing warnings.

Vite+ (VoidZero's `vp` CLI, `vite-plus` on npm) unifies Oxlint, Oxfmt, tsgo type-checking, Vitest, and Vite/Rolldown behind one CLI and one `vite.config.ts`. It recognizes bun as the package manager (bun.lock detection) and ships the `vp`/`oxlint`/`oxfmt` bins in the npm package, so a devDependency plus `bun run` covers everything — no global install; `vp` resolves from `node_modules/.bin` even in workflows without the `setup-vp` action.

Two constraints shaped the staged adoption:

- **`apps/api` is not a Vite project.** Dev/deploy are `alchemy dev`/`alchemy deploy` (ADR-0028) and the API runs on the bun runtime (ADR-0027, `@effect/platform-bun`). No part of the API surface moves to vp.
- **`template-sync.json`'s `overwrite` set (ADR-0024) must stay byte-identical to upstream.** The template owns `tsconfig.json`, `vitest.config.ts`, `flake.nix`, and many `scripts/` — files a naive `vp migrate` would rewrite. Template-owned files are excluded from the vp corpus entirely (derived from `template-sync.json` in `vite.config.ts`; mirrored in `.prettierignore`), which also means pre-existing lint warnings inside those files are upstream's to fix.

The check layer landed first; the web dev/build/test switch followed once its one risk was retired: `vp test` runs Vitest under vp's managed Node rather than bun, so the suite's runtime assumptions had to be re-verified before the switch — the full suite (384 tests, coverage thresholds held) passes, and `vp build`/`vp dev` work with the existing PWA and Tailwind plugins.

## Decision

1. **`vp check` is the lint/format gate.** `vite-plus` (pinned) is a root devDependency; `bun run lint` = `vp check` (Oxlint + Oxfmt check), `bun run fmt` = `vp fmt`. Configuration lives in the root `vite.config.ts`. The gate is blocking in CI (`ci.yml` `gate` job), consistent with "every gate blocking".
2. **Oxfmt is enforced, and the baseline was laid in one mechanical commit** (`vp fmt` across fork-owned files) so enforcement starts from a clean diff. Template-owned files are excluded via `.prettierignore`.
3. **`bun run check` stays `tsc`.** TypeScript 7 already is tsgo; vp's type-aware linting complements it, but tsc remains the type authority. No double gate, no config drift. The `tsc --noEmit` prefix in `apps/web`'s `build` script is load-bearing, not redundant: `bun run deploy` runs `build` without a preceding `check`, so it is the type gate on the deploy path.
4. **Scope: vp owns the check layer plus the web dev/build/test surface.** `apps/web` scripts are `vp dev` / `tsc --noEmit && vp build` / `vp preview`; the root `test` script is `vp test run --coverage` (verified: 384 tests, coverage thresholds held under vp's Node runtime). Package management and script routing stay bun (`bun run --filter`); Playwright e2e, size-limit, and the security scanners are not vp tools; `apps/api` stays `alchemy dev`/`alchemy deploy` (ADR-0028) on bun (ADR-0027). Anything further (vp task runner, vp pack, vp managing the API runtime) needs a new ADR.
5. **Version coupling: `apps/web`'s direct `vite` devDependency must track the Vite revision vp executes.** The direct dep cannot be dropped — `apps/web/vite.config.ts` imports from `"vite"` and the Vite plugins peer-resolve against it. `vp build`/`vp dev` execute vp's bundled Vite (8.2.2 at adoption; `vp --version` prints it), so a `vite-plus` bump can silently change the executing Vite while the config/plugins compile against the pinned one. The coupling is enforced, not just documented: `scripts/check-vp-vite-pin.mjs` runs as part of `bun run lint` and fails when the two revisions diverge.
6. **Template ownership is respected structurally, not by exemption.** `vite.config.ts` reads `template-sync.json` and derives lint `ignorePatterns` from its `overwrite` list; `.prettierignore` mirrors the same set. A template update that changes ownership is picked up by regenerating nothing — the config reads the manifest at runtime.
7. **Local install** (for contributors and dev shells; `flake.nix` is template-owned and untouched): `curl -fsSL https://vite.plus | bash`, or simply use `bun run lint` / `bun run fmt`, which resolve the bins from `node_modules`.

## Consequences

- Blocking CI gates: `setup-vp` action + `bun run lint` in the `gate` job; `bun run lint` joins the Definition of Done gate list.
- Tests execute under vp's managed Node, not bun. Verified equivalent at adoption (384 tests); a future test needing bun-specific APIs must opt into the bun runtime explicitly.
- The `truth` gate is satisfied by real importers (`vite.config.ts` imports `vite-plus`); no ALLOWLIST entry needed.
- The iteration-guardrail credits `bun run lint` through its existing `bun run (check|test|typecheck|lint)` pattern — the template-owned guardrail config needed no edit.
- 27 pre-existing lint warnings were fixed in fork-owned files as part of adoption; warnings in template-owned files arrive and leave with upstream.
- Formatting diffs will occasionally touch `.md`/`.yml`/`.json` outside source code (Oxfmt's default corpus); the `.prettierignore` boundary keeps template-owned docs, `INITIAL_IDEA.md`, and byte-exact fixtures untouched.
- `vite-plus` is young (0.x); version bumps are normal dependency churn, and the escape hatch is real — every capability it provides wraps a standard tool, and only the script surface (not business code) depends on it.

## Revisit triggers

- `vite-plus` reaches 1.0 or changes its runtime story: re-evaluate the Node-vs-bun test runtime and the `apps/web` `vite` coupling (decision 5).
- A second DARS consumer or a forking project needs a different toolchain: the vp surface is script-level only; swapping it does not touch `packages/` contracts.
- A template update adds files to the `overwrite` set that vp would format or lint: the derived ignore list updates automatically; no action needed beyond reviewing the diff.
