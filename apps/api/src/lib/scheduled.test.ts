import { describe, expect, it, vi } from "vite-plus/test";
import type { RagStore } from "@app/infra";
import type { StoreBridge } from "@app/kajianq-domain";
import { ChatConfigError } from "./chat-wiring";
import { cleanupExpiredSessions } from "./scheduled";

/**
 * The scheduled cleanup (ADR-0017): expired anonymous sessions are reclaimed
 * by the nightly `kajianq-cron.timer` (ADR-0044 decision 6). The handler must
 * be inert when the database binding is absent and must not throw on a store
 * fault — a cron run has no client to fail to, and a transient store error must
 * leave the rows for the next tick rather than page anyone.
 *
 * The two retention windows have INDEPENDENT error boundaries (ADR-0064): a session
 * cleanup that keeps failing must not stop the append-only access log's published
 * 90-day window from being enforced, so the tests drive each step's fault on its own.
 */

// The database client lives behind the RagStore adapter (ADR-0008), so
// these tests never reach one: constructing or querying the pool is
// the failure this mock makes loud.
vi.mock("pg", () => ({
  Pool: class {
    on(): void {}
    query(): never {
      throw new Error("scheduled test: the database must not be reached");
    }
  },
}));

/** A store stand-in exposing only the methods under test. The tag on the returned value
 * lets the fake bridge below tell the two steps apart; the seam's types are erased here
 * because the double deliberately answers values the seam does not allow (a non-number). */
function storeWith(cleanup: () => unknown, purge: () => unknown = () => 0): RagStore {
  return {
    cleanupExpiredSessions: cleanup,
    purgeAdminAccessLog: purge,
  } as unknown as RagStore;
}

/** The ONE cast the doubles need: a bridge that answers by the effect's own tag. */
function bridge(reply: (tag: string) => unknown): StoreBridge {
  return (async (effect: { __effect?: string }) => reply(effect.__effect ?? "?")) as StoreBridge;
}

describe("cleanupExpiredSessions", () => {
  it("skips (not fails) when the database binding is absent", async () => {
    const result = await cleanupExpiredSessions({});
    expect(result).toEqual({ deleted: null, adminLogDeleted: null, ok: false });
  });

  it("calls the store's cleanup and reports the reclaimed count", async () => {
    let called = 0;
    const store = storeWith(
      () => {
        called += 1;
        return { __effect: "sessions" };
      },
      () => ({ __effect: "admin-log" }),
    );
    const result = await cleanupExpiredSessions(
      { DATABASE_URL: "postgres://x" },
      {
        createStore: () => store,
        runStore: bridge((tag) => (tag === "sessions" ? 3 : 0)),
      },
    );
    expect(called).toBe(1);
    expect(result).toEqual({ deleted: 3, adminLogDeleted: 0, ok: true });
  });

  it("purges the admin access log by its own window in the same nightly run", async () => {
    let purged = 0;
    const result = await cleanupExpiredSessions(
      { DATABASE_URL: "postgres://x" },
      {
        createStore: () =>
          storeWith(
            () => ({ __effect: "sessions" }),
            () => {
              purged += 1;
              return { __effect: "admin-log" };
            },
          ),
        runStore: bridge((tag) => (tag === "admin-log" ? 7 : 1)),
      },
    );
    expect(purged).toBe(1);
    expect(result).toEqual({ deleted: 1, adminLogDeleted: 7, ok: true });
  });

  it("still enforces the access log's window when the session cleanup keeps failing", async () => {
    // The failure that matters: an append-only table's published retention is only true if
    // something deletes by it, and the session cleanup failing is exactly when nobody looks.
    let purged = 0;
    const result = await cleanupExpiredSessions(
      { DATABASE_URL: "postgres://x" },
      {
        createStore: () =>
          storeWith(
            () => ({ __effect: "sessions" }),
            () => {
              purged += 1;
              return { __effect: "admin-log" };
            },
          ),
        runStore: bridge((tag) => {
          if (tag === "sessions") throw new Error("session cleanup is down");
          return 7;
        }),
      },
    );
    expect(purged).toBe(1);
    // The session count is the failure (null); the purge's own count is still reported.
    expect(result).toEqual({ deleted: null, adminLogDeleted: 7, ok: false });
  });

  it("reports a non-numeric store result as a failure, never as '0 cleaned'", async () => {
    const result = await cleanupExpiredSessions(
      { DATABASE_URL: "postgres://x" },
      { createStore: () => storeWith(() => ({})), runStore: bridge(() => undefined) },
    );
    expect(result).toEqual({ deleted: null, adminLogDeleted: null, ok: false });
  });

  it("swallows a store fault (logged, not thrown) so the cron run survives", async () => {
    const result = await cleanupExpiredSessions(
      { DATABASE_URL: "postgres://x" },
      {
        createStore: () => storeWith(() => ({})),
        runStore: bridge(() => {
          throw new Error("store transient");
        }),
      },
    );
    expect(result).toEqual({ deleted: null, adminLogDeleted: null, ok: false });
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
    expect(result).toEqual({ deleted: null, adminLogDeleted: null, ok: false });
  });
});
