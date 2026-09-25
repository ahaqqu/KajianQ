/**
 * Structural type for a static-asset fetcher — no platform type import needed.
 * The serving path supplies the disk-backed one (`createDiskAssetFetcher`,
 * apps/api/src/lib/assets.ts); the shape is kept structural so this package
 * stays host-agnostic.
 */
export type AssetFetcher = { fetch: (request: Request) => Promise<Response> };

export type ServeAssetsOptions = {
  /**
   * Path prefixes belonging to the API namespace: served a machine-readable
   * JSON 404, never the SPA. Default `["/v1/"]`.
   */
  apiPrefixes?: readonly string[];
  /**
   * Path prefixes served with immutable caching (content-hashed build
   * output). Default `["/assets/"]`.
   */
  immutablePrefixes?: readonly string[];
};

const DEFAULT_API_PREFIXES: readonly string[] = ["/v1/"];
const DEFAULT_IMMUTABLE_PREFIXES: readonly string[] = ["/assets/"];
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/**
 * SPA fallback for the final catch-all route. Route every request through
 * the Hono stack first (so it gets the same security headers, CORS, and rate
 * limiting as the API), then call this from the catch-all. Content-hashed
 * assets are served `immutable`; HTML keeps a revalidating default so deploys
 * pick up new
 * asset hashes immediately.
 */
export async function serveAssets(
  request: Request,
  assets: AssetFetcher,
  opts: ServeAssetsOptions = {},
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if ((opts.apiPrefixes ?? DEFAULT_API_PREFIXES).some((p) => pathname.startsWith(p))) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const res = await assets.fetch(request);
  if (!(opts.immutablePrefixes ?? DEFAULT_IMMUTABLE_PREFIXES).some((p) => pathname.startsWith(p))) {
    return res;
  }
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", IMMUTABLE_CACHE);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
