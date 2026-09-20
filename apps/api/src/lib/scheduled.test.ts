import { describe, expect, it, vi } from "vitest";
import type { RagStore } from "@app/infra";
import { ChatConfigError } from "./chat-wiring";
import { cleanupExpiredSessions } from "./scheduled";

/**
 * The scheduled cleanup (ADR-0017, ticket #10): expired anonymous sessions
 * are reclaimed by the nightly `kajianq-cron.timer` (ADR-0044 decision 7,
 * previously a Worker cron). The handler must be inert when the database
 * binding is absent and must not throw on a store fault — a cron run has no
 * client to fail to, and a transient store error must leave the rows for the
 * next tick rather than page anyone.
 */

// The database client lives behind the RagStore adapter (ADR-0008), so
// these route tests never reach one: constructing or querying the pool is
// the failure this mock makes loud.
vi.mock("pg", () => ({
  Pool: class {
    on(): void {}
    query(): never {
      throw new Error("scheduled test: the database must not be reached");
    }
  },
}));

/** A store stand-in exposing only the method under test. */
function storeWith(cleanup: () => unknown): RagStore {
  return { cleanupExpiredSessions: cleanup } as unknown as RagStore;
}

describe("cleanupExpiredSessions", () => {
  it("skips (not fails) when the database binding is absent", async () => {
    const result = await cleanupExpiredSessions({});
    expect(result).toEqual({ deleted: null, ok: false });
  });

  it("calls the store's cleanup and reports the reclaimed count", async () => {
    let called = 0;
    const store = storeWith(() => {
      called += 1;
      return { __effect: true };
    });
    const result = await cleanupExpiredSessions(
      { DATABASE_URL: "postgres://x" },
      {
        createStore: () => store,
        runStore: async (effect) => {
          expect(effect).toEqual({ __effect: true });
          return 3;
        },
      },
    );
    expect(called).toBe(1);
    expect(result).toEqual({ deleted: 3, ok: true });
  });

  it("reports a non-numeric store result as a failure, never as '0 cleaned'", async () => {
    const result = await cleanupExpiredSessions(
      { DATABASE_URL: "postgres://x" },
      { createStore: () => storeWith(() => ({})), runStore: async () => undefined },
    );
    expect(result).toEqual({ deleted: null, ok: false });
  });

  it("swallows a store fault (logged, not thrown) so the cron run survives", async () => {
    const result = await cleanupExpiredSessions(
      { DATABASE_URL: "postgres://x" },
      {
        createStore: () => storeWith(() => ({})),
        runStore: async () => {
          throw new Error("store transient");
        },
      },
    );
    expect(result).toEqual({ deleted: null, ok: false });
  });

  it("rethrows a non-config store-construction failure (a real bug, not a disabled feature)", async () => {
    await expect(
      cleanupExpiredSessions(
        { DATABASE_URL: "postgres://x" },
        {
          createStore: () => {
            throw new Error("adapter bug");
          },
        },
      ),
    ).rejects.toThrow("adapter bug");
  });

  it("treats a typed config failure from the store factory as disabled, not broken", async () => {
    const result = await cleanupExpiredSessions(
      {},
      {
        createStore: () => {
          throw new ChatConfigError("no binding", "DATABASE_URL");
        },
      },
    );
    expect(result).toEqual({ deleted: null, ok: false });
  });
});
