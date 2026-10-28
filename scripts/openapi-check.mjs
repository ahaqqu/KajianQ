#!/usr/bin/env bun
import { createApi } from "../apps/api/src/app";
import { isAdminApiPath } from "../apps/api/src/lib/admin-paths";
import { toOpenApiPath } from "../apps/api/src/lib/openapi-path";

/**
 * openapi-check.mjs
 *
 * Fast agent-runnable check that the generated OpenAPI document stays in sync
 * with the registered Hono routes. The route coverage test in
 * apps/api/src/app.test.ts is the real gate; this script gives a quick local
 * command and a non-zero exit code when the doc is broken or drifting.
 *
 * Bun runs this script, so it imports the TS owners of the path normalization
 * and the admin namespace boundary directly — the same `toOpenApiPath` and
 * `isAdminApiPath` the coverage test uses, so the two checks cannot drift apart.
 * The admin namespace sits under `/v1` but is excluded from the public document,
 * so the registered set must exclude it too; the doc's own absence is pinned by
 * the route-coverage equality (the admin routes carry no OpenAPI metadata).
 */

const env = { ASSETS: { fetch } };

async function main() {
  const api = createApi();
  const res = await api.request("/openapi.json", {}, env);
  if (!res.ok) {
    console.error(`openapi:check failed: /openapi.json returned ${res.status}`);
    process.exit(1);
  }

  const doc = await res.json();
  if (doc.openapi !== "3.1.0") {
    console.error(`openapi:check failed: expected openapi 3.1.0, got ${doc.openapi}`);
    process.exit(1);
  }

  // Hono's route table uses `:param`; hono-openapi documents `{param}` —
  // normalized through the shared owner.
  const registered = [
    ...new Set(
      api.routes
        .filter((r) => r.path.startsWith("/v1/") && !isAdminApiPath(r.path) && r.method !== "ALL")
        .map((r) => `${r.method} ${toOpenApiPath(r.path)}`),
    ),
  ].sort();

  const documented = Object.entries(doc.paths)
    .flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`))
    .sort();

  const registeredJson = JSON.stringify(registered);
  const documentedJson = JSON.stringify(documented);

  if (registeredJson !== documentedJson) {
    console.error("openapi:check failed: documented routes do not match registered routes");
    console.error("Registered:");
    console.error(registeredJson);
    console.error("Documented:");
    console.error(documentedJson);
    process.exit(1);
  }

  console.log(`openapi:check OK (${registered.length} /v1 routes, OpenAPI ${doc.openapi})`);
}

main().catch((err) => {
  console.error("openapi:check failed:", err);
  process.exit(1);
});
