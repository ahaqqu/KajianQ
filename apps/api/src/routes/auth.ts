import { AuthResponseSchema } from "@app/contracts";
import { describeRoute, resolver } from "hono-openapi";
import { createAnonymousSession, deleteUserCascade } from "../lib/auth";
import { authGuard, newRouter, requireDb } from "../lib/guard";

export const authRoutes = newRouter()
  .post(
    "/v1/auth/anonymous",
    describeRoute({
      summary: "Create anonymous session",
      responses: {
        200: {
          description: "Session",
          content: { "application/json": { schema: resolver(AuthResponseSchema) } },
        },
      },
    }),
    async (c) => {
      return c.json(await createAnonymousSession(requireDb(c.env)));
    },
  )
  .delete(
    "/v1/auth/me",
    authGuard,
    describeRoute({
      summary: "Delete account and cascade data",
      responses: {
        204: { description: "Deleted" },
        401: { description: "Unauthorized" },
      },
    }),
    async (c) => {
      const { db, userId } = c.get("authed");
      await deleteUserCascade(db, userId);
      return c.body(null, 204);
    },
  );
