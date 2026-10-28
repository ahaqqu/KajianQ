import { describe, expect, it } from "vite-plus/test";
import { createLogger } from "@app/infra";
import { startApi } from "./boot";

/**
 * The process entry's one ordering claim: the `model_configs` mirror sync runs before
 * the socket binds, and a hung or failed sync still reaches the bind (ADR-0022
 * decision 3). This imports `boot.ts` itself — the line the claim lives on — with the
 * sync and the listener faked, so deleting the call or swapping the order reddens
 * here instead of leaving the PR body as the only witness.
 */

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ service: "api", route: "bootstrap" }, (line) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  });
  return { lines, logger };
}

const stop = async (): Promise<void> => {};

describe("the API process entry", () => {
  it("runs the mirror sync before the socket binds", async () => {
    const order: string[] = [];
    const { logger } = capture();
    const handle = await startApi(
      {},
      {
        sync: async () => {
          order.push("sync");
        },
        serve: () => {
          order.push("serve");
          return { stop };
        },
        logger,
      },
    );
    expect(order).toEqual(["sync", "serve"]);
    expect(handle.stop).toBe(stop);
  });

  it("runs the real mirror sync before the socket binds", async () => {
    const order: string[] = [];
    const { lines, logger } = capture();
    // No `sync` injected: this is the production wiring. An empty env has no
    // DATABASE_URL, so the real sync reports its "skipped" posture — a no-op default
    // would leave that line missing.
    await startApi(
      {},
      {
        serve: () => {
          order.push("serve");
          return { stop };
        },
        logger,
      },
    );
    expect(lines.find((line) => line.msg === "model_config.sync_skipped")).toMatchObject({
      level: "warn",
      missing: "DATABASE_URL",
    });
    expect(order).toEqual(["serve"]);
  });

  it("binds at the sync deadline instead of waiting on a hung store", async () => {
    const order: string[] = [];
    const { lines, logger } = capture();
    let settle: (() => void) | undefined;
    const hung = new Promise<void>((resolve) => {
      settle = resolve;
    });
    await startApi(
      {},
      {
        sync: () => hung,
        serve: () => {
          order.push("serve");
          return { stop };
        },
        logger,
        timeoutMs: 5,
      },
    );
    expect(order).toEqual(["serve"]);
    expect(lines.find((line) => line.msg === "model_config.sync_skipped")).toMatchObject({
      level: "warn",
      reason: "timeout",
      timeoutMs: 5,
    });
    // Settle the sync the deadline stopped waiting on, so its handlers run and the
    // test leaves no pending work behind.
    settle!();
    await hung;
  });

  it("still binds when the sync rejects unexpectedly", async () => {
    const order: string[] = [];
    const { lines, logger } = capture();
    await startApi(
      {},
      {
        sync: async () => {
          throw new Error("boom");
        },
        serve: () => {
          order.push("serve");
          return { stop };
        },
        logger,
      },
    );
    expect(order).toEqual(["serve"]);
    expect(lines.find((line) => line.msg === "model_config.sync_failed")).toMatchObject({
      level: "error",
      reason: "unexpected",
      error: "boom",
    });
  });
});
