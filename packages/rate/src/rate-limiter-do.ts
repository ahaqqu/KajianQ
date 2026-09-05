import { DurableObject } from "cloudflare:workers";
import { tickFixedWindow, type WindowState } from "./rate-limiter";

/**
 * One Durable Object per rate-limit key (see `createDurableObjectRateLimiter`).
 * Single-threaded and strongly consistent, so the counter is global across
 * Worker isolates and POPs. The alarm clears storage when the window lapses,
 * keeping state bounded to a single `{ count, start }` entry per active key.
 *
 * Adopting Workers must re-export this class from the Worker entrypoint and
 * bind it via the Alchemy stack file (see `packages/rate/README.md`).
 */
export class RateLimiterDo extends DurableObject {
  /** RPC: atomic check-and-increment against a fixed window. */
  async check(limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const cur = await this.ctx.storage.get<WindowState>("window");
    const result = tickFixedWindow(cur, now, limit, windowMs);
    await this.ctx.storage.put("window", {
      count: result.count,
      start: result.start,
    });
    // (Re)arm the alarm to fire when this window lapses. `setAlarm` replaces
    // any stale alarm, so a reset window is never wiped by a delayed one.
    if (result.reset || (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(result.start + windowMs);
    }
    return result.allowed;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}