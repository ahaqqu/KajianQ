import { describe, expect, it } from "vitest";
import { serveAssets, type AssetFetcher } from "./serve-assets";

function assetFetcher(body: string, contentType = "text/html"): AssetFetcher {
  return {
    fetch: async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": contentType },
      }),
  };
}

const request = (path: string) => new Request(`https://example.test${path}`);

describe("serveAssets", () => {
  it("returns a machine-readable JSON 404 inside the API namespace", async () => {
    const res = await serveAssets(request("/v1/missing"), assetFetcher("<html>"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("serves ASSETS untouched for non-API paths", async () => {
    const res = await serveAssets(
      request("/chat"),
      assetFetcher("<html>spa</html>"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.text()).toBe("<html>spa</html>");
  });

  it("serves content-hashed assets with immutable caching", async () => {
    const res = await serveAssets(
      request("/assets/index-Bx1k2.js"),
      assetFetcher("console.log(1)", "text/javascript"),
    );
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await res.text()).toBe("console.log(1)");
  });

  it("keeps immutable caching and status on ASSETS 304 revalidations", async () => {
    const revalidated: AssetFetcher = {
      fetch: async () => new Response(null, { status: 304 }),
    };
    const res = await serveAssets(request("/assets/index-Bx1k2.js"), revalidated);
    expect(res.status).toBe(304);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("honors custom API and immutable prefixes", async () => {
    const res = await serveAssets(request("/cdn/x.js"), assetFetcher("1"), {
      immutablePrefixes: ["/cdn/"],
    });
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const api = await serveAssets(request("/api/v1/x"), assetFetcher("<html>"), {
      apiPrefixes: ["/api/"],
    });
    expect(api.status).toBe(404);
  });
});