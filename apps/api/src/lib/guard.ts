import { Hono } from "hono";
import type { ApiEnv } from "../env";

export type { ApiEnv } from "../env";

/** Route-module factory carrying the app's bindings/variables generics. */
export function newRouter(): Hono<ApiEnv> {
  return new Hono<ApiEnv>();
}
