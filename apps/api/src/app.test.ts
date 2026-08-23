import { describe, expect, it, vi } from "vitest";
import { createApi } from "./app";

const { captureException } = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock("@sentry/cloudflare", () => ({ captureException }));

const env = { ASSETS: { fetch } };

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

  it("emits a restrictive Content-Security-Policy header", async () => {
    const res = await createApi().request("/v1/health", {}, env);
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
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
});
