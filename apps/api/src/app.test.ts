import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "@app/local-first";
import { createApi } from "./app";
import { DbUnboundError } from "./lib/db";

const { captureException } = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock("@sentry/cloudflare", () => ({ captureException }));

vi.mock("./lib/auth", () => ({
  createAnonymousSession: vi.fn(async () => ({
    userId: "00000000-0000-4000-8000-000000000000",
    token: "t".repeat(32),
    expiresAt: Date.now() + 60_000,
  })),
  resolveUserId: vi.fn(async (_db: unknown, header?: string) =>
    header === "Bearer good" ? "u1" : null,
  ),
  deleteUserCascade: vi.fn(async () => undefined),
}));

const { listNotes, syncNotes } = vi.hoisted(() => ({
  listNotes: vi.fn(async () => []),
  syncNotes: vi.fn(async () => []),
}));

vi.mock("./lib/notes-repo", () => ({ listNotes, syncNotes }));

const env = { ASSETS: { fetch }, DB: {} as never };
const authed = { headers: { Authorization: "Bearer good" } };

const spaHtml = "<!doctype html><html><body>SPA</body></html>";
const spaEnv = {
  ...env,
  ASSETS: {
    fetch: async (): Promise<Response> =>
      new Response(spaHtml, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  },
};

const cspDefaults = [
  "default-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

function assertSecurityHeaders(res: Response) {
  const csp = res.headers.get("Content-Security-Policy");
  expect(csp).toBeTruthy();
  for (const directive of cspDefaults) {
    expect(csp).toContain(directive);
  }
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  expect(res.headers.get("Permissions-Policy")).toBe(
    "camera=(), microphone=(), geolocation=()",
  );
  expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
}

type Doc = {
  openapi: string;
  info: { title: string };
  paths: Record<string, Record<string, Record<string, unknown>>>;
};

beforeEach(() => {
  captureException.mockClear();
  listNotes.mockClear();
  syncNotes.mockClear();
});

describe("createApi routes", () => {
  it("serves health with a correlation id", async () => {
    const res = await createApi().request("/v1/health", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Correlation-Id")).toBeTruthy();
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("creates an anonymous session", async () => {
    const res = await createApi().request(
      "/v1/auth/anonymous",
      { method: "POST" },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token.length).toBeGreaterThanOrEqual(16);
  });

  it("rejects account deletion without a token and deletes with one", async () => {
    const api = createApi();
    expect((await api.request("/v1/auth/me", { method: "DELETE" }, env)).status)
      .toBe(401);
    const res = await api.request(
      "/v1/auth/me",
      { method: "DELETE", ...authed },
      env,
    );
    expect(res.status).toBe(204);
  });

  it("lists notes for an authed user", async () => {
    const api = createApi();
    expect((await api.request("/v1/notes", {}, env)).status).toBe(401);
    const res = await api.request("/v1/notes", authed, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notes: [] });
  });

  it("maps a thrown DbUnboundError to 503 and captures it", async () => {
    const noDb = { ASSETS: { fetch } };
    const res = await createApi().request("/v1/notes", authed, noDb);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "db_unbound" });
    expect(captureException).toHaveBeenCalledOnce();
    expect(captureException.mock.calls[0]?.[0]).toBeInstanceOf(DbUnboundError);
  });

  it("returns 500 and captures unexpected errors", async () => {
    listNotes.mockRejectedValueOnce(new Error("boom"));
    const res = await createApi().request("/v1/notes", authed, env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    expect(captureException).toHaveBeenCalledOnce();
  });

  it("reflects the allowlisted request origin and rejects others", async () => {
    const corsEnv = { ...env, ALLOWED_ORIGINS: "http://localhost:8787" };
    const api = createApi();
    const ok = await api.request(
      "/v1/health",
      { headers: { Origin: "http://localhost:8787" } },
      corsEnv,
    );
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:8787",
    );
    const bad = await api.request(
      "/v1/health",
      { headers: { Origin: "https://evil.example" } },
      corsEnv,
    );
    expect(bad.headers.get("Access-Control-Allow-Origin")).not.toBe(
      "https://evil.example",
    );
  });

  it("blocks cross-origin requests when ALLOWED_ORIGINS is empty", async () => {
    const api = createApi();
    const res = await api.request(
      "/v1/health",
      { headers: { Origin: "https://evil.example" } },
      { ...env, ALLOWED_ORIGINS: "" },
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("emits the shared security headers on API routes", async () => {
    const res = await createApi().request("/v1/health", {}, env);
    assertSecurityHeaders(res);
  });

  it("serves the SPA through the middleware stack with the same headers", async () => {
    const res = await createApi().request("/", {}, spaEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(spaHtml);
    assertSecurityHeaders(res);
  });

  it("returns a JSON 404 for unknown /v1/* paths instead of the SPA", async () => {
    const res = await createApi().request("/v1/missing", {}, spaEnv);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("serves content-hashed assets with immutable caching", async () => {
    const res = await createApi().request("/assets/index-Bx1k2.js", {}, spaEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    assertSecurityHeaders(res);
  });
});

describe("POST /v1/sync", () => {
  const post = (body: unknown, init: RequestInit = {}) =>
    createApi().request(
      "/v1/sync",
      {
        method: "POST",
        ...init,
        headers: { "Content-Type": "application/json", ...init.headers },
        body: JSON.stringify(body),
      },
      env,
    );

  it("checks auth before validating the body", async () => {
    const res = await post({ nonsense: true });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid body with 400", async () => {
    const res = await post({ nonsense: true }, authed);
    expect(res.status).toBe(400);
  });

  it("rejects a schema-version mismatch with 409", async () => {
    const res = await post(
      { schemaVersion: SCHEMA_VERSION - 1, clientVersion: "test", notes: [] },
      authed,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; serverSchemaVersion: number };
    expect(body.error).toBe("schema_mismatch");
    expect(body.serverSchemaVersion).toBe(SCHEMA_VERSION);
    expect(syncNotes).not.toHaveBeenCalled();
  });

  it("merges notes and returns serverNow", async () => {
    const res = await post(
      { schemaVersion: SCHEMA_VERSION, clientVersion: "test", notes: [] },
      authed,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      schemaVersion: number;
      serverNow: number;
      notes: unknown[];
    };
    expect(body.schemaVersion).toBe(SCHEMA_VERSION);
    expect(body.serverNow).toBeGreaterThan(0);
    expect(body.notes).toEqual([]);
  });
});

describe("generated OpenAPI doc", () => {
  async function getDoc(): Promise<{ api: ReturnType<typeof createApi>; doc: Doc }> {
    const api = createApi();
    const res = await api.request("/openapi.json", {}, env);
    expect(res.status).toBe(200);
    return { api, doc: (await res.json()) as Doc };
  }

  it("serves /openapi.json and /docs", async () => {
    const { doc } = await getDoc();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Agentic Template API");
    const docs = await createApi().request("/docs", {}, env);
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/html");
  });

  it("covers every registered /v1 route exactly (no doc drift)", async () => {
    const { api, doc } = await getDoc();
    const registered = [
      ...new Set(
        api.routes
          .filter((r) => r.path.startsWith("/v1/") && r.method !== "ALL")
          .map((r) => `${r.method} ${r.path}`),
      ),
    ].sort();
    expect(registered.length).toBeGreaterThan(0);
    const documented = Object.entries(doc.paths)
      .flatMap(([path, methods]) =>
        Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`),
      )
      .sort();
    expect(documented).toEqual(registered);
  });

  it("documents sync request body, response, and error responses", async () => {
    const { doc } = await getDoc();
    const sync = doc.paths["/v1/sync"]?.["post"] as {
      requestBody?: { content: Record<string, { schema: unknown }> };
      responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
    };
    expect(sync.requestBody?.content["application/json"]?.schema).toBeTruthy();
    expect(sync.responses["200"]?.content?.["application/json"]?.schema)
      .toBeTruthy();
    expect(sync.responses["401"]).toBeTruthy();
    expect(sync.responses["409"]).toBeTruthy();
  });
});
