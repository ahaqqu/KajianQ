import { describe, expect, it, vi } from "vitest";
import { createApi } from "./app";
import { CHAT_MESSAGE_MAX_LENGTH } from "@app/contracts";
import type { AssetFetcher } from "@app/hardening";
import { toOpenApiPath } from "./lib/openapi-path";

const { captureException } = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock("@sentry/bun", () => ({ captureException }));

const spaHtml = "<!doctype html><html><body>SPA</body></html>";

function mockAssets(): AssetFetcher {
  return {
    fetch: async (_request: Request) =>
      new Response(spaHtml, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  };
}

const env = { ASSETS: mockAssets() };

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
  expect(res.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
  expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
}

type Doc = {
  openapi: string;
  info: { title: string };
  paths: Record<string, Record<string, Record<string, unknown>>>;
};

describe("createApi routes", () => {
  it("serves health with a correlation id", async () => {
    const res = await createApi().request("/v1/health", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Correlation-Id")).toBeTruthy();
    const body = (await res.json()) as { status: string; schemaVersion: number };
    expect(body.status).toBe("ok");
    expect(body.schemaVersion).toBe(1);
  });

  it("normalizes trailing slashes on /v1/health", async () => {
    const res = await createApi().request("/v1/health/", {}, env);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toMatch(/\/v1\/health$/);
  });

  it("returns JSON 404 for unknown /v1/* paths", async () => {
    const res = await createApi().request("/v1/foo", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("reflects the allowlisted request origin and rejects others", async () => {
    const corsEnv = { ...env, ALLOWED_ORIGINS: "http://localhost:8787" };
    const api = createApi();
    const ok = await api.request(
      "/v1/health",
      { headers: { Origin: "http://localhost:8787" } },
      corsEnv,
    );
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8787");
    const bad = await api.request(
      "/v1/health",
      { headers: { Origin: "https://evil.example" } },
      corsEnv,
    );
    expect(bad.headers.get("Access-Control-Allow-Origin")).not.toBe("https://evil.example");
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

  it("emits the shared security headers on the SPA root", async () => {
    const res = await createApi().request("/", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    assertSecurityHeaders(res);
  });

  it("emits the shared security headers on a client-side route", async () => {
    const res = await createApi().request("/chat", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    assertSecurityHeaders(res);
  });

  it("serves content-hashed assets with immutable caching", async () => {
    const res = await createApi().request("/assets/index-CTkTHNJp.js", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    assertSecurityHeaders(res);
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
    expect(doc.info.title).toBe("KajianQ API");
    const docs = await createApi().request("/docs", {}, env);
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/html");
  });

  it("covers every registered /v1 route exactly (no doc drift)", async () => {
    const { api, doc } = await getDoc();
    // Hono's route table uses `:param`; hono-openapi documents `{param}`.
    // Both sides normalize through the shared owner (thermo-review B3) that
    // scripts/openapi-check.mjs also imports, so the two checks agree.
    const registered = [
      ...new Set(
        api.routes
          .filter((r) => r.path.startsWith("/v1/") && r.method !== "ALL")
          .map((r) => `${r.method} ${toOpenApiPath(r.path)}`),
      ),
    ].sort();
    expect(registered.length).toBeGreaterThan(0);
    const documented = Object.entries(doc.paths)
      .flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`))
      .sort();
    expect(documented).toEqual(registered);
  });

  it("documents the chat message ceiling on the request body (#256)", async () => {
    const { doc } = await getDoc();
    // The limit lives on the API's documented surface, not only in the code:
    // a client reading /openapi.json sees the same ceiling the route enforces,
    // and the description says what an over-length message answers.
    const body = doc.paths["/v1/chat"]?.["post"]?.["requestBody"] as
      | {
          content: {
            "application/json": {
              schema: { properties: { message: { maxLength?: number; description?: string } } };
            };
          };
        }
      | undefined;
    const message = body?.content["application/json"].schema.properties.message;
    expect(message?.maxLength).toBe(CHAT_MESSAGE_MAX_LENGTH);
    expect(message?.description).toContain(`${CHAT_MESSAGE_MAX_LENGTH} characters`);
    expect(message?.description).toContain("invalid_request");
    // The trim/length rule is part of the documented surface too (#256 C1):
    // a client must not assume a body that trims to the ceiling is accepted.
    expect(message?.description).toContain("no trim");
  });

  it("documents the sessionId's UUID format on the request body (#271)", async () => {
    const { doc } = await getDoc();
    // The format lives on the API's documented surface, not only in the code:
    // a client reading /openapi.json can see that a non-UUID sessionId is a
    // client error, not a server fault — the 500 this ticket removes was
    // reachable by a body the published contract accepted.
    const body = doc.paths["/v1/chat"]?.["post"]?.["requestBody"] as
      | {
          content: {
            "application/json": {
              schema: {
                properties: { sessionId: { format?: string; description?: string } };
              };
            };
          };
        }
      | undefined;
    const sessionId = body?.content["application/json"].schema.properties.sessionId;
    expect(sessionId?.format).toBe("uuid");
    expect(sessionId?.description).toContain("invalid_request");
    // The no-oracle half is published too: a well-formed unknown/foreign id
    // still answers the documented 404.
    expect(sessionId?.description).toContain("404");
  });
});
