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
| Business logic, Zod schemas, store queries, adapter logic, route handlers in isolation | Vitest (unit) | Mock adapters; test the contract, not the implementation |
| Sync merge, client migrations, webhook idempotency | fast-check (property) | Randomly generated inputs; laws that must hold for all inputs |
| User-facing flows, offline-to-online sync, PWA lifecycle | Playwright-BDD | Full stack running against wrangler dev; real browser |
| Bundle size | size-limit | Every PR |

If unsure, start at the highest feasible layer: BDD for user flows, property tests for logic with laws, unit tests for everything else.

## Unit tests (Vitest)

### When to write

Every piece of business logic, every module boundary, every Zod schema, every adapter implementation. Write the test before or alongside the implementation.

### File conventions

- Unit tests live beside the module they test: `src/foo.ts` → `src/foo.test.ts`
- Test files import `describe`/`it`/`expect` from `vitest`

### Pattern: testing a Zod schema

Schemas are the external boundary. Test them with both valid and invalid inputs.

```ts
import { describe, it, expect } from "vitest";
import { CreateWidgetSchema } from "./widgets";

describe("CreateWidgetSchema", () => {
  it("accepts valid input", () => {
    const result = CreateWidgetSchema.safeParse({
      name: "My Widget",
      price: 1000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = CreateWidgetSchema.safeParse({ name: "My Widget" });
    expect(result.success).toBe(false);
  });

  it("rejects negative price", () => {
    const result = CreateWidgetSchema.safeParse({ name: "X", price: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = CreateWidgetSchema.safeParse({ name: "", price: 100 });
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
- Sync merge logic (idempotency, commutativity, delete propagation)
- Client migration logic (round-trip: migrate up then down returns original)
- Webhook idempotency (same payload twice produces same state as once)

The AGENTS.md guardrail: "When implementing merge logic, you MUST make it idempotent, commutative, and propagate deletes."

### File conventions

- Property tests live in `*.prop.test.ts` files beside the module.
- Import from `fast-check` and `vitest` together: `import { test, fc } from "@fast-check/vitest"`

### Pattern: sync merge idempotency

Idempotency: merging the same change twice produces the same result as merging it once.

```ts
import { test, fc } from "@fast-check/vitest";
import { expect } from "vitest";
import { createMergeableStore } from "tinybase";
import { mergeChanges } from "./merge";

test.prop([fc.record({
  id: fc.uuid(),
  title: fc.string({ minLength: 1 }),
  done: fc.boolean(),
})])(
  "merge is idempotent",
  (change) => {
    const store = createMergeableStore();
    mergeChanges(store, [change]);

    const stateAfterFirst = store.getTables();
    mergeChanges(store, [change]);

    expect(store.getTables()).toEqual(stateAfterFirst);
  }
);
```

### Pattern: sync merge commutativity

Commutativity: merging in any order produces the same final state.

```ts
test.prop([
  fc.array(fc.record({
    id: fc.uuid(),
    title: fc.string({ minLength: 1 }),
    done: fc.boolean(),
  }), { minLength: 1, maxLength: 10 }),
  fc.shuffledSubarray([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
])(
  "merge is commutative",
  (changes, order) => {
    const store1 = createMergeableStore();
    for (const i of order) {
      if (i < changes.length) mergeChanges(store1, [changes[i]!]);
    }

    const store2 = createMergeableStore();
    for (const change of changes) {
      mergeChanges(store2, [change]);
    }

    expect(store1.getTables()).toEqual(store2.getTables());
  }
);
```

### Pattern: delete propagation

Delete propagation: a delete always wins over any concurrent update.

```ts
test.prop([fc.record({
  id: fc.uuid(),
  title: fc.string({ minLength: 1 }),
})])(
  "delete beats concurrent update",
  (item) => {
    const store = createMergeableStore();
    mergeChanges(store, [item]);
    const update = { ...item, title: "updated" };
    const deleteOp = { ...item, _deleted: true };

    mergeChanges(store, [update, deleteOp]);
    const tables = store.getTables();
    expect(tables.widgets?.[item.id]).toBeUndefined();
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

> As a user, I want to see a list of my widgets so that I can manage them.

Derive:
- **Happy path**: Given widgets exist, when I open the list, I see them.
- **Empty state**: Given no widgets, when I open the list, I see a message.
- **Error state**: Given the network is down, when I open the list, I see cached data or an error.
- **Offline**: Given I'm offline, when I create a widget, it appears immediately and syncs when online.
- **Edge case**: Given 1000 widgets, the list paginates and doesn't block the UI.

Example feature file:

```gherkin
Feature: Widget List
  As a user
  I want to see a list of my widgets
  So that I can manage them

  Scenario: View widgets
    Given I have 3 widgets in my account
    When I navigate to the widgets page
    Then I see 3 widgets displayed

  Scenario: Empty widget list
    Given I have no widgets
    When I navigate to the widgets page
    Then I see an empty state message

  Scenario: Offline widget creation
    Given I am offline
    When I create a new widget named "Test"
    Then the widget appears in the list immediately
    And the widget syncs when I come online
```

### Pattern: step definitions

```ts
import { Given, When, Then } from "@cucumber/cucumber";
import { expect } from "@playwright/test";

Given("I have {int} widgets in my account", async function (count: number) {
  await seedWidgets(this.page, count);
});

When("I navigate to the widgets page", async function () {
  await this.page.goto("/widgets");
});

Then("I see {int} widgets displayed", async function (count: number) {
  const items = this.page.locator("[data-testid='widget-item']");
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
- [ ] Property tests for sync merge assert idempotency, commutativity, and delete propagation.
- [ ] Property tests for webhook handlers assert idempotency on random payloads.
- [ ] BDD scenarios exist for every new user-facing flow, including offline and error states.
- [ ] `vp test` passes with coverage above 80% on changed files.
