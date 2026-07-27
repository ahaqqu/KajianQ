import {
  AuthResponseSchema,
  NoteListSchema,
  SyncRequestSchema,
  SyncResponseSchema,
} from "@app/shared-zod";
import { CLIENT_VERSION, SCHEMA_VERSION } from "@app/sync-protocol";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { allowedOrigins, resolveEnvName, type WorkerBindings } from "./env";
import {
  createAnonymousSession,
  deleteUserCascade,
  resolveUserId,
} from "./lib/auth";
import { createRequestContext } from "./lib/context";
import { requireDb } from "./lib/db";
import { listNotes, syncNotes } from "./lib/notes-repo";
import { openApiDocument } from "./lib/openapi";
import { allowRequest } from "./lib/rate-limit-mw";
import { buildHealth } from "./routes/health";

type Vars = { correlationId: string };

export function createApi() {
  const api = new Hono<{ Bindings: WorkerBindings; Variables: Vars }>();

  api.use("*", secureHeaders());
  api.use("*", async (c, next) => {
    const origins = allowedOrigins(c.env.ALLOWED_ORIGINS);
    return cors({
      origin: (origin) => {
        // Same-origin browser navigations omit Origin; API clients send it.
        if (!origin) return origins[0] ?? "*";
        if (origins.includes(origin)) return origin;
        // Allow the worker's own host (SPA + API same origin).
        try {
          const reqHost = new URL(c.req.url).origin;
          if (origin === reqHost) return origin;
        } catch {
          /* ignore */
        }
        return "";
      },
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-Correlation-Id"],
    })(c, next);
  });

  api.use("*", async (c, next) => {
    const id = c.req.header("X-Correlation-Id") ?? crypto.randomUUID();
    c.set("correlationId", id);
    c.header("X-Correlation-Id", id);
    const ip = c.req.header("CF-Connecting-IP") ?? "local";
    if (!(await allowRequest(`ip:${ip}`))) {
      return c.json({ error: "rate_limited" }, 429);
    }
    await next();
  });

  api.get("/v1/health", (c) => {
    const ctx = createRequestContext(
      resolveEnvName(c.env.APP_ENV),
      c.get("correlationId"),
    );
    return c.json(buildHealth(ctx));
  });

  api.post("/v1/auth/anonymous", async (c) => {
    const db = requireDb(c.env);
    return c.json(AuthResponseSchema.parse(await createAnonymousSession(db)));
  });

  api.delete("/v1/auth/me", async (c) => {
    const db = requireDb(c.env);
    const userId = await resolveUserId(db, c.req.header("Authorization"));
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    await deleteUserCascade(db, userId);
    return c.body(null, 204);
  });

  api.get("/v1/notes", async (c) => {
    const db = requireDb(c.env);
    const userId = await resolveUserId(db, c.req.header("Authorization"));
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    return c.json(NoteListSchema.parse({ notes: await listNotes(db, userId) }));
  });

  api.post("/v1/sync", async (c) => {
    const db = requireDb(c.env);
    const userId = await resolveUserId(db, c.req.header("Authorization"));
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const body = SyncRequestSchema.parse(await c.req.json());
    if (body.schemaVersion !== SCHEMA_VERSION) {
      return c.json(
        {
          error: "schema_mismatch",
          serverSchemaVersion: SCHEMA_VERSION,
          clientSchemaVersion: body.schemaVersion,
        },
        409,
      );
    }
    const notes = await syncNotes(db, userId, body.notes);
    return c.json(
      SyncResponseSchema.parse({ schemaVersion: SCHEMA_VERSION, notes }),
    );
  });

  api.get("/openapi.json", (c) => c.json(openApiDocument()));
  api.get("/docs", (c) =>
    c.html(
      `<!doctype html><html lang="en"><body><h1>API</h1><a href="/openapi.json">OpenAPI</a> · schema ${SCHEMA_VERSION} · client ${CLIENT_VERSION}</body></html>`,
    ),
  );

  return api;
}
