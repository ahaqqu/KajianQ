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

| What you're testing | Tool | Needs |
|---|---|---|
| Business logic, Valibot schemas, store queries, adapter logic, route handlers in isolation | Vitest (unit) | Mock adapters; test the contract, not the implementation |
| Sync merge, client migrations, webhook idempotency | fast-check (property) | Randomly generated inputs; laws that must hold for all inputs |
| User-facing flows, offline-to-online sync, PWA lifecycle | Playwright-BDD | Full stack running against wrangler dev; real browser |
| Bundle size | size-limit | Every PR |

If unsure, start at the highest feasible layer: BDD for user flows, property tests for logic with laws, unit tests for everything else.

## Exemplary test files

Each pattern below is exemplified by a real, CI-green file in this repo. Cite path, open it, and mirror its structure — schema of the test, mocking seam, naming — not its subject matter.

| Pattern | Exemplary file |
|---|---|
| Valibot schema at the boundary: valid, empty, and type-invalid inputs | `packages/contracts/src/note.test.ts` |
| Business logic over injected dependencies: clock injection and hand-written fakes | `packages/rate/src/rate-limiter.test.ts` |
| Route handlers exercised directly at the unit layer | `apps/api/src/app.test.ts` |
| Adapter implementation honoring its interface contract (incl. missing-key / delete paths) | `packages/infra/src/object-store.test.ts` |
| Sync merge properties: idempotency, associativity, delete-wins | `packages/local-first/src/merge.prop.test.ts` |
| Tombstone GC safety properties | `packages/local-first/src/tombstones.prop.test.ts` |
| Client migration round-trip property | `packages/local-first/src/migrations.prop.test.ts` |
| BDD feature file + step definitions for a user-facing flow | `tests/features/notes.feature` and `tests/steps/notes.steps.ts` |

Webhook idempotency (same payload twice = same state as once) is a mandatory property whenever a consuming project adds payments — this template ships without payments (see `CONTEXT.md`), so it has no exemplary file yet; the first one written becomes the reference.

## Layer conventions

### Unit tests (Vitest)

- Every business logic module, Valibot schema, and adapter implementation gets one; write them in the test phase, once the module exists (see `guided-implementation` phase boundaries).
- Tests live beside the module they test: `src/foo.ts` → `src/foo.test.ts`.
- Mock at adapter boundaries, not at function boundaries — the adapter interface is the test seam (see the rate-limiter exemplar).

### Property tests (fast-check)

- Mandatory for sync merge logic, client migrations, and webhook handlers; the LWW-element-set CRDT laws (idempotency, commutativity including exact-timestamp ties, associativity, delete propagation, tombstone GC safety) are the `guided-implementation` guardrail.
- Files are `*.prop.test.ts` beside the module; import `{ test, fc }` from `@fast-check/vitest`.
- The generator must exhaust the input space of the law — hand-picked values make it a unit test in `fc` syntax.

### BDD tests (Playwright-BDD)

- Every user-facing flow per the AGENTS.md Definition of Done; scenarios describe what the user does and sees.
- Enumerate each user story into scenarios for: happy path, empty state, error state, offline, and one edge case (e.g. max volume).
- Features in `tests/features/<feature>.feature`, steps in `tests/steps/<feature>.steps.ts` (see the notes exemplar).

### Integration tests (adapter boundaries)

- Adapter implementations also get integration tests that exercise the interface contract end to end: against real infrastructure (D1, R2) in CI, or mocks locally. The unit-layer contract shape is the `packages/infra/src/object-store.test.ts` exemplar; full-stack real-infra coverage rides the BDD layer (wrangler dev).

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
- [ ] Every changed module has a corresponding `*.test.ts` or `*.prop.test.ts` file.
- [ ] Unit tests cover happy path, all error paths, and at least one edge case (empty, max, concurrent).
- [ ] Property tests for sync merge assert idempotency, commutativity (including exact-timestamp ties), associativity, delete propagation, and GC safety.
- [ ] Property tests for webhook handlers assert idempotency on random payloads.
- [ ] BDD scenarios exist for every new user-facing flow, including offline and error states.
- [ ] `bun run test` passes with coverage above 80% on changed files.

## Effect programs (ADR-0027)

Engine code returns `Effect` values; tests run them via `Effect.runPromise` / `Effect.runPromiseExit` under vitest (no `@effect/vitest`, no test-clock dependency — inject `now`/fakes through the same seams production uses):

- **Success path:** `await Effect.runPromise(effect)` — or the promise-level bridge under test (`runPipelinePromise`).
- **Failure path:** `const exit = await Effect.runPromiseExit(effect)` then `Cause.failureOption(exit.cause)` — assert on the typed error (`_tag`, `kind`, `stage`), never on the `FiberFailure` wrapper.
- **Services:** provide tags with `Effect.provideService` / a `Layer` (see `packages/rag-core/src/effect-spike.test.ts`); a `Context.Tag` service in tests is a plain object (see `packages/rag-core/src/run.test.ts` for the `RunContext` pattern).
- **Exemplars:** `packages/rag-core/src/run.test.ts` (stages as Effects, finalizers, config threading), `packages/infra/src/providers/sse-stream.test.ts` (Stream interruption via `Effect.runFork` + `Fiber.interrupt`), `packages/infra/src/providers/provider-factory.test.ts` (fast injected retry schedules).
- **Keep retry schedules fast:** inject `perKindRetrySchedule("1 millis", "1 millis")` in tests; never sleep through real backoff.
