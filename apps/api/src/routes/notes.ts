import { NoteListSchema } from "@app/contracts";
import { describeRoute, resolver } from "hono-openapi";
import { authGuard, newRouter } from "../lib/guard";
import { listNotes } from "../lib/notes-repo";

export const notesRoutes = newRouter().get(
  "/v1/notes",
  authGuard,
  describeRoute({
    summary: "List notes",
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: resolver(NoteListSchema) } },
      },
      401: { description: "Unauthorized" },
    },
  }),
  async (c) => {
    const { db, userId } = c.get("authed");
    return c.json({ notes: await listNotes(db, userId) });
  },
);
