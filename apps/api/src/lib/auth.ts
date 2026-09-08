import { Effect } from "effect";
import type { RagStore } from "@app/infra";
import type { Context } from "hono";
import type { Authed, ApiEnv } from "../env";

/**
 * Auth guard for guarded routes (#8): resolve the Bearer token to a user via
 * the RagStore session seam (ADR-0017 anonymous sessions) and stash the
 * `Authed` variable for the handler. Returns a 401 Response on a missing,
 * malformed, or unknown token; undefined when the guard passes. The store's
 * Effect-signatured methods (ADR-0027 decision 7) bridge through
 * `Effect.runPromise` here — the HTTP edge's one bridge point.
 */
export async function authGuard(
  c: Context<ApiEnv>,
  store: RagStore,
): Promise<Response | undefined> {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token === "") {
    return c.json({ error: "unauthorized" }, 401);
  }
  const userId = (await Effect.runPromise(store.resolveUserId(token) as never)) as string | null;
  if (userId === null) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const authed: Authed = { store, userId };
  c.set("authed", authed);
  return undefined;
}