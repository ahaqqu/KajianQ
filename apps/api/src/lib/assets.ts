import { readFileSync, statSync } from "node:fs";
import type { AssetFetcher } from "@app/hardening";

/**
 * A disk-backed `ASSETS` fetcher for the Bun serving entry (#181, ADR-0044).
 *
 * The Hono app's catch-all calls `serveAssets(request, c.env.ASSETS)`, which
 * applies the API-prefix 404 and the immutable-cache policy (ADR-0041's
 * /v1-only metering assumes this shape). On Cloudflare, `ASSETS` was a runtime
 * binding injected by the static-assets configuration; self-hosted there is no
 * such binding, so this module is the structural equivalent: it reads the
 * built SPA off disk and returns a `{ fetch }` handle the app can be given.
 *
 * It deliberately does NOT re-implement the cache/404 policy — that stays in
 * `@app/hardening`'s `serveAssets`, so the two hosts cannot disagree.
 *
 * `node:fs` rather than `Bun.file`: the module is unit-tested under the repo's
 * Node test runner, and a `Bun` global would make the behavior untestable in
 * the gate that matters. The Bun process provides `node:fs` unchanged.
 */

/** Path-traversal-safe join: a URL path can never escape `root`. */
function safeSegments(pathname: string): string[] {
  const decoded = decodeURIComponent(pathname);
  return decoded
    .split("/")
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json",
  map: "application/json; charset=utf-8",
};

/** Read a regular file, or null when it is missing or not a regular file. */
function readIfFile(path: string): Buffer | null {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * Build an `ASSETS` handle over a directory of built SPA files. A request for
 * a file that exists is served as-is (with a content type by extension); every
 * other path falls back to `index.html`, because the app is a client-side
 * router and any deep link must reach the shell.
 */
export function createDiskAssetFetcher(root: string): AssetFetcher {
  const base = root.replace(/\/$/, "");
  const indexPath = `${base}/index.html`;
  return {
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      const segments = safeSegments(pathname);
      const candidate = `${base}/${segments.join("/")}`;
      const ext = (segments.at(-1)?.split(".").at(-1) ?? "").toLowerCase();
      const file = readIfFile(segments.length === 0 ? indexPath : candidate);
      if (file !== null) {
        return new Response(file, {
          headers: { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" },
        });
      }
      // A missing path falls back to the SPA shell so a client-side route
      // works on reload. Without a build there is no shell to serve, and a
      // 503 says so plainly rather than returning an HTML error as if it were
      // the app (the proxy's own 502 would be indistinguishable from a bug).
      const shell = readIfFile(indexPath);
      if (shell === null) return new Response("SPA build not found", { status: 503 });
      return new Response(shell, { headers: { "content-type": CONTENT_TYPES.html! } });
    },
  };
}
