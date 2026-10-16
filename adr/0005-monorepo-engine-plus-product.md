# ADR-0005: One monorepo holds the DARS engine packages and the KajianQ product app

## Decision

KajianQ and DARS live in one monorepo using workspaces: DARS as domain-agnostic packages under `packages/`, KajianQ as the product app under `apps/` plus its domain pack. Package boundaries are what enforce DARS's genericity. DARS moves to its own repository only when a second real consumer of the engine appears.

## Why

Reusability is a stated goal and no second use case exists yet, so building DARS as a standalone platform first pays platform costs — a release and versioning surface, a second pipeline, a registry — for a consumer that does not exist. Building KajianQ alone and generalizing later fails in the other direction: every abstraction is then extracted under product pressure, with the first caller's shape already baked in.

Rejected: a standalone DARS platform before a second consumer; a product-only repository that would generalize later.

## Consequences

- Engine packages carry zero Islamic-domain logic and zero vendor names; the boundary gate enforces it.
- Shared, project-agnostic logic lands in `packages/<name>`, never in `apps/`; `apps/` is the composition root a fork owns and customizes.
- **Revisit when** a second real DARS consumer appears, or a fork needs a release cadence the monorepo cannot give it.
