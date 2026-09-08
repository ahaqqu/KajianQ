---
name: writing-tests
description: "Use when writing tests of any kind: unit, property, BDD, or integration. Read docs/ARCHITECTURE.md §10 for testing requirements and AGENTS.md for guardrails."
source: project
synced: 2026-08-29
---

# Writing Tests

Generate correct, guardrail-compliant tests at the right layer. Load this skill when the run enters the test phase — after code exists to test (per `docs/ARCHITECTURE.md` §10, >80% coverage gate). The patterns are not inlined here: the repo's own suites are the pattern library, cited below. Read the one matching your case before writing tests of that kind.

## Test layer decision

Pick the right test layer before writing anything. The table from `docs/ARCHITECTURE.md` §10 is authoritative:

| What you're testing                                                                         | Tool                         | Needs                                                                  |
| ------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| Business logic, Valibot schemas, store queries, adapter logic, route handlers in isolation  | Vitest (unit)                | Mock adapters; test the contract, not the implementation               |
| Engine programs and seam logic (Effect signatures)                                          | Vitest + `Effect.runPromise` | Run the Effect program under test; mock adapters behind the seam       |
| Logic with laws (schema invariants, cost accounting, merge/CRDT logic if ever reintroduced) | fast-check (property)        | Randomly generated inputs; laws that must hold for all inputs          |
| User-facing flows, PWA lifecycle                                                            | Playwright-BDD               | Full stack running against `alchemy dev` (local workerd); real browser |
| Bundle size                                                                                 | size-limit                   | Every PR                                                               |

If unsure, start at the highest feasible layer: BDD for user flows, property tests for logic with laws, unit tests for everything else.

## Exemplary test files

Each pattern below is exemplified by a real, CI-green file in this repo. Cite path, open it, and mirror its structure — schema of the test, mocking seam, naming — not its subject matter.

| Pattern                                                                                   | Exemplary file                                                  |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Valibot schema at the boundary + property laws over trace/cost shapes                     | `packages/contracts/src/trace.test.ts`                          |
| Business logic over injected dependencies: clock injection and hand-written fakes         | `packages/rate/src/rate-limiter.test.ts`                        |
| Route handlers exercised directly at the unit layer                                       | `apps/api/src/app.test.ts`                                      |
| Adapter implementation honoring its interface contract (incl. missing-key / delete paths) | `packages/infra/src/object-store.test.ts`                       |
| Effect-signatured adapter behind its seam: fake store, `Effect.runPromise` harness        | `packages/rag-ingest/src/pipeline.test.ts`                      |
| Store-seam contract suite against real Postgres semantics                                 | `packages/infra/src/rag-store-neon.test.ts`                     |
| BDD feature file + step definitions for a user-facing flow                                | `tests/features/shell.feature` and `tests/steps/shell.steps.ts` |

This repo ships no payments or sync layer (see `CONTEXT.md` / spec §3.1), so there are no webhook-idempotency or CRDT exemplars. If a consuming project ever adds one, the same property-test discipline below applies — the first file written becomes the reference.

## Layer conventions

### Unit tests (Vitest)

- Every business logic module, Valibot schema, and adapter implementation gets one; write them in the test phase, once the module exists (see `guided-implementation` phase boundaries). On `model:high` tickets the senior-implementer writes tests as part of the same run.
- Tests live beside the module they test: `src/foo.ts` → `src/foo.test.ts`.
- Mock at adapter boundaries, not at function boundaries — the adapter interface is the test seam (see the rate-limiter exemplar).

### Effect programs (Vitest + `Effect.runPromise`)

- Engine packages (`rag-core`, `infra`, `rag-ingest`, `eval`) carry Effect-signatured seams; tests build the program with a fake adapter (hand-written object satisfying the interface), then run it under `Effect.runPromise` inside a normal Vitest `test()` (see the `rag-ingest` pipeline exemplar).
- Assert on the typed error channel (`StoreError` kinds, `ProviderErrorKind`) by feeding the fake a failing dependency — failure modes are data now; test each kind, not just the happy path.

### Property tests (fast-check)

- Mandatory for any logic with laws: schema invariants, cost/trace accounting, and any merge/CRDT logic a plan introduces. Files are `*.test.ts` or `*.prop.test.ts` beside the module; import `{ fc, test }` from `@fast-check/vitest` (see the trace exemplar).
- The generator must exhaust the input space of the law — hand-picked values make it a unit test in `fc` syntax.

### BDD tests (Playwright-BDD)

- Every user-facing flow per the AGENTS.md Definition of Done; scenarios describe what the user does and sees.
- Enumerate each user story into scenarios for: happy path, empty state, error state, offline, and one edge case (e.g. max volume).
- Features in `tests/features/<feature>.feature`, steps in `tests/steps/<feature>.steps.ts` (see the notes exemplar).

### Integration tests (adapter boundaries)

- Adapter implementations also get integration tests that exercise the interface contract end to end: against real infrastructure (Neon Postgres, R2) in CI, or mocks locally. The unit-layer contract shape is the `packages/infra/src/object-store.test.ts` exemplar; the store-seam contract suite is `packages/infra/src/rag-store-neon.test.ts`; full-stack real-infra coverage rides the BDD layer (`alchemy dev` on local workerd).

## Guards

- Tests MUST test external behavior, not implementation details. Test what the module does, not how it does it.
- Property tests MUST exhaust the generator space. Don't write a property test that only tests three hand-picked values — that's a unit test with `fc` syntax.
- BDD scenarios MUST describe the user's observable behavior. No "when I set localStorage" — describe what the user does and sees.
- Mock at adapter boundaries, not at function boundaries. The adapter interface is the test seam.
- Coverage MUST be above 80%. If a test can't reach coverage, the module is too coupled — refactor, don't force the test.
- Dates, numbers, and currency in tests MUST use the `Intl` API — the same as the code under test.
- Never test third-party code (libraries, frameworks). Test your integration with them, not their internals.

## Completion criterion

Tests are done when:

- [ ] Every changed module has a corresponding test file (`*.test.ts` / `*.prop.test.ts`).
- [ ] Unit tests cover happy path, all error paths (including every typed error kind on Effect seams), and at least one edge case (empty, max, concurrent).
- [ ] Property tests exist for any logic with laws the plan introduced, asserting those laws on generated inputs.
- [ ] BDD scenarios exist for every new user-facing flow, including offline and error states.
- [ ] `bun run test` passes with coverage above 80% lines/functions/statements and 70% branches on changed files.
