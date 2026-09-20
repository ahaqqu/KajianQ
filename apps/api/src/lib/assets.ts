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

/**
 * Read a regular file as bytes, or null when it is missing or not a regular
 * file.
 *
 * The returned `ArrayBuffer` is sliced to the file's exact bytes rather than
 * handing back the Buffer's whole backing store: `readFileSync` may return a
 * view into node's shared pool, so `.buffer` alone can carry adjacent data.
 * `ArrayBuffer` (not `Buffer`/`Uint8Array`) is also the shape the DOM
 * `Response` body type accepts in the app's own typecheck — node's
 * `Uint8Array<ArrayBufferLike>` is not assignable to `BufferSource`.
 */
function readIfFile(path: string): ArrayBuffer | null {
  try {
    if (!statSync(path).isFile()) return null;
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  } catch {
    return null;
  }
}

/**
 * Content type for a path. A path with no extension is a client-side ROUTE
 * (`/`, `/chat`, `/about`), not a file worth downloading — serving those as
 * `application/octet-stream` makes the browser download the HTML instead of
 * rendering it, which is exactly the failure this lookup must not have. So the
 * default is `text/html`, not `application/octet-stream`, and only a path that
 * actually names an extension looks one up.
 */
function contentTypeFor(segments: readonly string[]): string {
  const last = segments.at(-1) ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0) return CONTENT_TYPES.html!;
  return CONTENT_TYPES[last.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
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
      const file = readIfFile(segments.length === 0 ? indexPath : candidate);
      if (file !== null) {
        return new Response(file, { headers: { "content-type": contentTypeFor(segments) } });
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
