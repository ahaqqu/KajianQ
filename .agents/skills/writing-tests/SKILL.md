---
name: writing-tests
description: Use when writing tests of any kind: unit, property, BDD, or integration. Read docs/ARCHITECTURE.md §10 for testing requirements and AGENTS.md for guardrails.
---

# Writing Tests

Generate correct, guardrail-compliant tests at the right layer. Use this skill whenever implementing code that needs testing — which is all code per `docs/ARCHITECTURE.md` §10 (>80% coverage gate).

## Test layer decision

Pick the right test layer before writing anything. The table from `docs/ARCHITECTURE.md` §10 is authoritative:

| What you're testing | Tool | Needs |
|---|---|---|
| Business logic, Valibot schemas, store queries, adapter logic, route handlers in isolation | Vitest (unit) | Mock adapters; test the contract, not the implementation |
| Sync merge, client migrations, webhook idempotency | fast-check (property) | Randomly generated inputs; laws that must hold for all inputs |
| User-facing flows, offline-to-online sync, PWA lifecycle | Playwright-BDD | Full stack running against wrangler dev; real browser |
| Bundle size | size-limit | Every PR |

If unsure, start at the highest feasible layer: BDD for user flows, property tests for logic with laws, unit tests for everything else.

## Unit tests (Vitest)

### When to write

Every piece of business logic, every module boundary, every Valibot schema, every adapter implementation. Write the test before or alongside the implementation.

### File conventions

- Unit tests live beside the module they test: `src/foo.ts` → `src/foo.test.ts`
- Test files import `describe`/`it`/`expect` from `vitest`

### Pattern: testing a Valibot schema

Schemas are the external boundary. Test them with both valid and invalid inputs.

```ts
import { describe, it, expect } from "vitest";
import * as v from "valibot";
import { CreateNoteSchema } from "@app/contracts";

describe("CreateNoteSchema", () => {
  it("accepts valid input", () => {
    const result = v.safeParse(CreateNoteSchema, {
      title: "My note",
      body: "content",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = v.safeParse(CreateNoteSchema, { title: "My note" });
    expect(result.success).toBe(false);
  });

  it("rejects empty title", () => {
    const result = v.safeParse(CreateNoteSchema, { title: "", body: "content" });
    expect(result.success).toBe(false);
  });
});
```

### Pattern: testing business logic with mocked adapters

Business logic depends on adapter interfaces, not implementations. Mock the interface, test the logic.

```ts
import { describe, it, expect, vi } from "vitest";
import type { ObjectStore } from "@project/infra";
import { createWidget } from "./widgets";

function mockObjectStore(): ObjectStore {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };
}

describe("createWidget", () => {
  it("stores the widget and returns it", async () => {
    const store = mockObjectStore();
    const result = await createWidget(store, { name: "W", price: 100 });
    expect(result.name).toBe("W");
    expect(store.put).toHaveBeenCalledOnce();
  });

  it("throws when widget name is empty", async () => {
    const store = mockObjectStore();
    await expect(createWidget(store, { name: "", price: 100 }))
      .rejects.toThrow();
  });
});
```

### Pattern: testing route handlers

Route handlers are tested by calling them directly with a mock Hono context. Do not test through HTTP in unit tests — that's what BDD covers.

```ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { testClient } from "hono/testing";

describe("GET /v1/widgets", () => {
  it("returns empty list when no widgets", async () => {
    const app = new Hono().get("/v1/widgets", listWidgets);
    const res = await app.request("/v1/widgets");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ widgets: [] });
  });
});
```

## Property tests (fast-check)

### When to write

Property tests are mandatory for:
- Sync merge logic (idempotency, commutativity, associativity, delete propagation, tombstone GC safety)
- Client migration logic (round-trip: migrate up then down returns original)
- Webhook idempotency (same payload twice produces same state as once)

The AGENTS.md / `guided-implementation` guardrail: the custom LWW-element-set CRDT in `packages/local-first` must be idempotent, commutative (including exact-timestamp ties), associative, propagate deletes, and safely GC tombstones.

### File conventions

- Property tests live in `*.prop.test.ts` files beside the module.
- Import from `fast-check` and `vitest` together: `import { test, fc } from "@fast-check/vitest"`

### Pattern: sync merge idempotency

Idempotency: merging the same change twice produces the same result as merging it once.

```ts
import { test, fc } from "@fast-check/vitest";
import { expect } from "vitest";
import { mergeNotes, type NoteRow } from "@app/local-first";

const noteArbitrary = fc.record({
  id: fc.uuid(),
  title: fc.string({ minLength: 1 }),
  body: fc.string(),
  updatedAt: fc.integer({ min: 1 }),
});

test.prop([fc.array(noteArbitrary, { minLength: 1, maxLength: 20 })])(
  "merge is idempotent",
  (changes) => {
    const first = mergeNotes([], changes);
    const second = mergeNotes(first, changes);
    expect(second).toEqual(first);
  }
);
```

### Pattern: sync merge commutativity

Commutativity: merging in any order produces the same final state (including exact-timestamp ties).

```ts
test.prop([
  fc.array(noteArbitrary, { minLength: 1, maxLength: 20 }),
  fc.uniqueArray(fc.integer({ min: 0, max: 19 }), {
    minLength: 1,
    maxLength: 20,
  }),
])(
  "merge is commutative",
  (changes, order) => {
    const shuffled = order
      .map((i) => changes[i])
      .filter((c): c is NoteRow => Boolean(c));
    const viaShuffle = mergeNotes([], shuffled);
    const viaOriginal = mergeNotes([], changes);
    expect(viaShuffle).toEqual(viaOriginal);
  }
);
```

### Pattern: delete propagation

Delete propagation: a tombstone always wins over any concurrent update.

```ts
test.prop([fc.record({
  id: fc.uuid(),
  title: fc.string({ minLength: 1 }),
  body: fc.string(),
  updatedAt: fc.integer({ min: 1 }),
})])(
  "delete beats concurrent update",
  (item) => {
    const update = { ...item, title: "updated", updatedAt: item.updatedAt + 1 };
    const tombstone = { ...item, title: item.title, updatedAt: item.updatedAt + 1, deleted: true };

    const merged = mergeNotes([item], [update, tombstone]);
    expect(merged.find((n) => n.id === item.id)?.deleted).toBe(true);
  }
);
```

### Pattern: webhook idempotency

```ts
test.prop([fc.record({
  event_type: fc.constantFrom("payment.succeeded", "payment.failed"),
  id: fc.uuid(),
  amount: fc.integer({ min: 100, max: 100000 }),
})])(
  "webhook handler is idempotent",
  async (payload) => {
    const { handleWebhook } = await import("./handler");
    const db = createTestDb(); // in-memory D1 for tests

    await handleWebhook(db, payload);
    const state1 = await db.select().from("payments").all();

    await handleWebhook(db, payload);
    const state2 = await db.select().from("payments").all();

    expect(state2.length).toBe(state1.length);
    expect(state2).toEqual(state1);
  }
);
```

### Pattern: client migration round-trip

```ts
test.prop([fc.record({
  id: fc.uuid(),
  name: fc.string(),
})])(
  "migration round-trip preserves data",
  (oldFormat) => {
    const migrated = migrationV2ToV3(oldFormat);
    const back = migrationV3ToV2(migrated);
    expect(back).toEqual(oldFormat);
  }
);
```

## BDD tests (Playwright-BDD)

### When to write

Every user-facing flow. Every API or UI change per AGENTS.md Definition of Done. BDD tests describe behavior, not implementation.

### File conventions

- BDD feature files: `tests/features/<feature>.feature`
- Step definitions: `tests/steps/<feature>.steps.ts`

### Pattern: deriving scenarios from specs

Given a spec user story:

> As a user, I want to see a list of my notes so that I can manage them.

Derive:
- **Happy path**: Given notes exist, when I open the list, I see them.
- **Empty state**: Given no notes, when I open the list, I see a message.
- **Error state**: Given the network is down, when I open the list, I see cached data or an error.
- **Offline**: Given I'm offline, when I create a note, it appears immediately and syncs when online.
- **Edge case**: Given 1000 notes, the list paginates and doesn't block the UI.

Example feature file:

```gherkin
Feature: Note List
  As a user
  I want to see a list of my notes
  So that I can manage them

  Scenario: View notes
    Given I have 3 notes in my account
    When I navigate to the notes page
    Then I see 3 notes displayed

  Scenario: Empty note list
    Given I have no notes
    When I navigate to the notes page
    Then I see an empty state message

  Scenario: Offline note creation
    Given I am offline
    When I create a new note titled "Test"
    Then the note appears in the list immediately
    And the note syncs when I come online
```

### Pattern: step definitions

```ts
import { Given, When, Then } from "@cucumber/cucumber";
import { expect } from "@playwright/test";

Given("I have {int} notes in my account", async function (count: number) {
  await seedNotes(this.page, count);
});

When("I navigate to the notes page", async function () {
  await this.page.goto("/notes");
});

Then("I see {int} notes displayed", async function (count: number) {
  const items = this.page.locator("[data-testid='note-item']");
  await expect(items).toHaveCount(count);
});
```

## Integration tests (adapter boundaries)

Test that each adapter implementation honors its interface contract. These run against real infrastructure in CI (D1, R2) or mocks locally.

```ts
describe("D1 ObjectStore adapter", () => {
  const store = createD1ObjectStore(testDb);

  it("put then get returns the same value", async () => {
    await store.put("test-key", { hello: "world" });
    const result = await store.get("test-key");
    expect(result).toEqual({ hello: "world" });
  });

  it("get missing key returns null", async () => {
    const result = await store.get("nonexistent");
    expect(result).toBeNull();
  });

  it("delete removes the value", async () => {
    await store.put("key", "value");
    await store.delete("key");
    expect(await store.get("key")).toBeNull();
  });
});
```

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
