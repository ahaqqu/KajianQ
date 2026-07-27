# ADR-0001: Working Hello World template (no bootstrap)

**Status:** accepted  
**Date:** 2026-07-25

## Context

Prose-only bootstrap caused high variance and unproven gates across agent runs.

## Decision

Ship this repo as a deployable Hello World monorepo. Remove `bootstrap-project`.

## Rationale

A green, deployable baseline beats agent-invented scaffolding for multi-project reuse.

## Consequences

- Features start from `grill-with-docs` / tickets, not mkdir.
- Template upgrades are normal PRs against a working tree.
- First clone must pass `bun install && bun run check && bun run test && bun run build`.
