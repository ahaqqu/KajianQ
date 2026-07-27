import {
  createMemoryConfigStore,
  createMemoryObjectStore,
  createR2ObjectStore,
  createSentry,
} from "@app/infra";
import { SCHEMA_VERSION } from "@app/sync-protocol";
import { createApi } from "./app";
import type { WorkerBindings } from "./env";

const api = createApi();

function isApiPath(pathname: string): boolean {
  return (
    pathname.startsWith("/v1/") ||
    pathname === "/openapi.json" ||
    pathname === "/docs"
  );
}

export default {
  async fetch(
    request: Request,
    env: WorkerBindings,
    ctx: unknown,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (isApiPath(url.pathname)) {
      try {
        return await api.fetch(request, env, ctx as never);
      } catch (err) {
        createSentry(env.SENTRY_DSN).captureException(err);
        if (err instanceof Error && err.message === "db_unbound") {
          return Response.json({ error: "db_unbound" }, { status: 503 });
        }
        return Response.json({ error: "internal" }, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: unknown, env: WorkerBindings): Promise<void> {
    const store = env.BUCKET
      ? createR2ObjectStore(env.BUCKET)
      : createMemoryObjectStore();
    const config = createMemoryConfigStore();
    const stamp = new Date().toISOString();
    await store.put(
      `backups/${stamp}.json`,
      JSON.stringify({
        at: stamp,
        schemaVersion: SCHEMA_VERSION,
        flag: await config.get("backup"),
      }),
    );
  },
};
