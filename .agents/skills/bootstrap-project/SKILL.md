---
name: bootstrap-project
description: Use when starting a new project from this template. Scaffolds the monorepo, flake.nix, CI, wrangler.toml, and all package scaffolding so the agent can proceed to implementation in one step.
---

# Bootstrap Project

Scaffold a complete, working project from this template so the implementing agent can start building features immediately without spending turns on file layout, tooling, or CI.

## Inputs

- Ask the user for: project name, Cloudflare account ID, and whether they want the Nix flake or an alternative.
- `docs/ARCHITECTURE.md` — the monorepo layout, technology choices, and CI pipeline must match exactly.
- `AGENTS.md` — every generated file must comply with guardrails.

## Phase 1 — Scaffold directories

Create the full monorepo layout. Every directory must exist before files are written so imports resolve.

```bash
mkdir -p apps/web/src/{routes,components,lib,hooks,styles} apps/web/public \
         apps/api/src/{routes,lib,middleware} apps/api/test \
         packages/shared-zod/src packages/db-schema/{src,migrations} \
         packages/sync-protocol/src packages/infra/src \
         .github/workflows adr docs
```

## Phase 2 — Root package.json

Create `package.json` with Bun workspaces. Use the project name from user input.

```jsonc
{
  "name": "<project-name>",
  "private": true,
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "dev": "vp dev",
    "build": "vp build",
    "check": "vp check",
    "test": "vp test",
    "clean": "rm -rf dist node_modules .wrangler"
  },
  "devDependencies": {
    "vite": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:",
    "@open-wc/testing": "catalog:"
  }
}
```

Set up the `pnpm-workspace.yaml` equivalent for Bun if needed, and `package.json` catalog entries for version alignment.

## Phase 3 — TypeScript

Create root `tsconfig.base.json` with strict mode, path aliases, and the Works Dojo monorepo preset if available. Each package gets a `tsconfig.json` that extends base.

```jsonc
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "jsx": "react-jsx",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "types": ["@cloudflare/workers-types"],
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

## Phase 4 — flake.nix

Create a Nix flake that pins Bun, Node, Wrangler, and all CLI tools. The flake must be self-contained and reproducible.

```nix
{
  description = "<project-name> dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            bun
            nodejs_22
            wrangler
            git
            gh
          ];
          shellHook = ''
            echo "Bun $(bun --version) | Node $(node --version) | Wrangler $(wrangler --version)"
          '';
        };
      });
}
```

## Phase 5 — wrangler.toml

Create `apps/api/wrangler.toml` with D1, R2, Cron, and Static Assets bindings. All secrets are placeholders — the agent must run `wrangler secret put` for each.

```toml
name = "<project-name>-api"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "<project-name>-db"
database_id = "<replace-with-d1-id>"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "<project-name>-bucket"

[triggers]
crons = []

[assets]
binding = "ASSETS"
directory = "../web/dist"

[observability]
enabled = true

[placement]
mode = "smart"
```

## Phase 6 — CI workflows

Create `.github/workflows/ci.yml` — the PR gate. Must include lint, typecheck, test, coverage, size-limit, and security scans per `docs/ARCHITECTURE.md` §6 and §10.

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cachix/install-nix-action@v27
      - run: nix develop --command bun install
      - run: nix develop --command vp check
      - run: nix develop --command vp test --coverage
      - run: nix develop --command vp size-limit
      - uses: github/codeql-action/init@v3
      - uses: github/codeql-action/analyze@v3
      - run: nix develop --command osv-scanner --lockfile=bun.lock
      - run: nix develop --command semgrep scan --config=auto
      - run: nix develop --command gitleaks detect --source .
```

Create `.github/workflows/e2e.yml` — Playwright-BDD against wrangler dev.

```yaml
name: E2E
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]
jobs:
  bdd:
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cachix/install-nix-action@v27
      - run: nix develop --command bun install
      - run: nix develop --command vp e2e
```

Create `.github/workflows/staging.yml` and `deploy.yml` with the pipeline: staging deploy → BDD + DAST + fuzz → promote to production + smoke tests.

## Phase 7 — Package scaffolding

For each package, create minimal `package.json`, `tsconfig.json`, and `src/index.ts` that re-exports the public API. Examples:

### packages/shared-zod

```jsonc
// package.json
{
  "name": "@<project>/shared-zod",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "zod": "catalog:",
    "@hono/zod-openapi": "catalog:"
  }
}
```

### packages/db-schema

```jsonc
{
  "name": "@<project>/db-schema",
  "type": "module",
  "main": "./src/index.ts",
  "dependencies": {
    "drizzle-orm": "catalog:",
    "@<project>/shared-zod": "workspace:*"
  },
  "devDependencies": {
    "drizzle-kit": "catalog:"
  }
}
```

### packages/sync-protocol

```jsonc
{
  "name": "@<project>/sync-protocol",
  "type": "module",
  "main": "./src/index.ts",
  "dependencies": {
    "@<project>/shared-zod": "workspace:*"
  }
}
```

Create `packages/sync-protocol/src/index.ts` with `SCHEMA_VERSION`:

```ts
export const SCHEMA_VERSION = 1;
```

### packages/infra

```jsonc
{
  "name": "@<project>/infra",
  "type": "module",
  "main": "./src/index.ts",
  "dependencies": {
    "@<project>/shared-zod": "workspace:*"
  }
}
```

### apps/api

```jsonc
{
  "name": "@<project>/api",
  "type": "module",
  "main": "./src/index.ts",
  "dependencies": {
    "hono": "catalog:",
    "@hono/zod-openapi": "catalog:",
    "better-auth": "catalog:",
    "drizzle-orm": "catalog:",
    "@<project>/shared-zod": "workspace:*",
    "@<project>/db-schema": "workspace:*",
    "@<project>/sync-protocol": "workspace:*",
    "@<project>/infra": "workspace:*"
  },
  "devDependencies": {
    "wrangler": "catalog:",
    "@cloudflare/workers-types": "catalog:"
  }
}
```

### apps/web

```jsonc
{
  "name": "@<project>/web",
  "type": "module",
  "dependencies": {
    "react": "catalog:",
    "react-dom": "catalog:",
    "@tanstack/react-router": "catalog:",
    "@tanstack/react-query": "catalog:",
    "tinybase": "catalog:",
    "@<project>/shared-zod": "workspace:*",
    "@<project>/sync-protocol": "workspace:*"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "catalog:",
    "vite-plugin-pwa": "catalog:",
    "tailwindcss": "catalog:"
  }
}
```

## Phase 8 — Install and verify

```bash
bun install
vp check
```

If `vp` is not yet configured, scaffold the Vite+ config file(s) at the root. The minimum is a `vite.config.ts` per app and a root orchestrator.

## Phase 9 — Initial files

Create the minimum viable entry points:

- `apps/api/src/index.ts` — Hono app with `/v1/health` route, CORS middleware, secure headers, and the adapter layer wired.
- `apps/web/src/index.html` and `apps/web/src/main.tsx` — React root with TanStack Router provider, TanStack Query provider, and PWA registration.
- `packages/infra/src/index.ts` — re-exports adapters as they are built.

## Guards

- Do NOT scaffold code that calls adapter implementations before the interface is defined in `packages/infra`.
- Do NOT add any paid dependency. Every `catalog:` entry must resolve to a free-tier compatible version.
- Do NOT generate a `.env` file — secrets go through `wrangler secret` only.
- Verify `.gitignore` exists (included in this template) before creating files that could leak secrets.

## Completion criterion

- [ ] All directories match the monograph layout in `docs/ARCHITECTURE.md`.
- [ ] `bun install` succeeds with zero errors.
- [ ] `vp check` passes (or the project is in a state where it will pass once package-level tsconfigs are tuned).
- [ ] `wrangler.toml` has all required bindings declared.
- [ ] All four CI workflow files exist and reference the correct `nix develop` prefix.
- [ ] `flake.nix` produces a shell where `bun --version`, `node --version`, and `wrangler --version` all work.
- [ ] Agent can proceed to guided-implementation without touching scaffolding.
