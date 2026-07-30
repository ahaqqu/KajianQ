import { Hono, type Context, type Next } from "hono";
import type { ApiEnv } from "../env";
import { resolveUserId } from "./auth";
import { requireDb } from "./db";

export type { ApiEnv } from "../env";
export { requireDb } from "./db";

/** Route-module factory carrying the app's bindings/variables generics. */
export function newRouter(): Hono<ApiEnv> {
  return new Hono<ApiEnv>();
}

/**
 * Route-facing request guard. Runs before body validation so unauthenticated
 * requests always get 401, never a 400 validation leak.
 */
export async function authGuard(
  c: Context<ApiEnv>,
  next: Next,
): Promise<Response | void> {
  const db = requireDb(c.env);
  const userId = await resolveUserId(db, c.req.header("Authorization"));
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  c.set("authed", { db, userId });
  await next();
}
